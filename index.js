const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Playwright server OK');
});

const hotelesBuscados = [
  'mavi',
  'hugo',
  'fin de semana',
  'clibomar',
  'tres anclas',
  'albatros',
  'porto',
  'san luis'
];

const MAX_INTENTOS = 3;

const limpiarPrecio = (texto) => {
  if (!texto) return null;

  const limpio = String(texto)
    .replace(/\s+/g, ' ')
    .replace(/[^\d,.-]/g, '')
    .replace(',', '.')
    .trim();

  return limpio || null;
};

const normalizarNombre = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const recorrer = (value, visit, seen = new WeakSet()) => {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;

  seen.add(value);
  visit(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      recorrer(item, visit, seen);
    }
    return;
  }

  for (const key of Object.keys(value)) {
    recorrer(value[key], visit, seen);
  }
};

const resultadoVacio = () =>
  hotelesBuscados.map((hotel) => ({
    hotel,
    nombre: hotel,
    precio: null,
    precio_original: null,
    precio_actual: null,
    fuente: null
  }));

const esperar = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

app.post('/scrape', async (req, res) => {
  const { url } = req.body || {};

  if (!url) {
    return res.status(400).json({
      ok: false,
      error: 'Falta url'
    });
  }

  let browser = null;
  let ultimoError = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ]
    });

    for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
      let context = null;

      console.log(`BOOKING: intento ${intento} de ${MAX_INTENTOS}`);
      console.log('URL RECIBIDA DE MAKE:', url);

      try {
        // Cada intento utiliza un contexto nuevo.
        context = await browser.newContext({
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/122.0.0.0 Safari/537.36',
          viewport: {
            width: 1366,
            height: 768
          },
          locale: 'es-ES'
        });

        const page = await context.newPage();

        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 60000
        });

        console.log(
          'URL JUSTO DESPUES DE GOTO:',
          page.url()
        );

        await page.waitForTimeout(4000);

        console.log(
          'URL ANTES DE COOKIES:',
          page.url()
        );

        const btnCookies = page.locator(
          'button:has-text("Aceptar")'
        );

        if (await btnCookies.count() > 0) {
          await btnCookies.first().click().catch(() => {});
        }

        console.log(
          'URL DESPUES DE COOKIES:',
          page.url()
        );

        // Esperamos a que aparezcan los resultados.
        // No usamos networkidle porque Booking puede
        // mantener solicitudes de red activas.
        await page.locator(
          '[data-testid="property-card"]'
        ).first().waitFor({
          state: 'attached',
          timeout: 15000
        }).catch(() => {});

        // Si Booking ha redirigido a otra página,
        // provocamos un nuevo intento.
        if (!page.url().includes('/searchresults.')) {
          throw new Error(
            'Booking ha redirigido fuera de los resultados: ' +
            page.url()
          );
        }

        // Desplazamiento gradual para cargar más hoteles.
        // Guardamos los datos DOM durante el recorrido
        // para no perder tarjetas que desaparezcan al hacer scroll.
        const encontradosDOM = [];
        const nombresVistos = new Set();

        const recogerTarjetas = async () => {
          const tarjetas = page.locator(
            '[data-testid="property-card"]'
          );

          const cantidad = await tarjetas.count();

          for (let i = 0; i < cantidad; i++) {
            const hotel = tarjetas.nth(i);

            const name = await hotel.locator(
              '[data-testid="title"]'
            ).innerText().catch(() => '');

            if (!name) continue;

            const nombreLower = normalizarNombre(name);

            let precioOriginalTxt = '';
            let precioActualTxt = '';

            const candidatosOriginal = [
              '[data-testid="strikethrough-price"]',
              '[data-testid="price-before-discount"]',
              '[data-testid="crossedout-price"]',
              's',
              'del'
            ];

            for (const selector of candidatosOriginal) {
              const loc = hotel.locator(selector).first();

              if (await loc.count()) {
                const txt = await loc.innerText()
                  .catch(() => '');

                if (txt && /\d/.test(txt)) {
                  precioOriginalTxt = txt;
                  break;
                }
              }
            }

            precioActualTxt = await hotel.locator(
              '[data-testid="price-and-discounted-price"]'
            ).first().innerText().catch(() => '');

            const precioOriginal = limpiarPrecio(
              precioOriginalTxt
            );

            const precioActual = limpiarPrecio(
              precioActualTxt
            );

            const dato = {
              nombre: name,
              nombreLower,
              precioOriginal,
              precioActual,
              precio: precioOriginal || precioActual,
              fuente: 'dom'
            };

            if (!nombresVistos.has(nombreLower)) {
              encontradosDOM.push(dato);
              nombresVistos.add(nombreLower);
            } else {
              const indice = encontradosDOM.findIndex(
                (h) => h.nombreLower === nombreLower
              );

              if (
                indice >= 0 &&
                !encontradosDOM[indice].precio &&
                dato.precio
              ) {
                encontradosDOM[indice] = dato;
              }
            }
          }
        };

        await recogerTarjetas();

        for (let i = 0; i < 8; i++) {
          if (!page.url().includes('/searchresults.')) {
            throw new Error(
              'Booking ha cambiado de página durante el scroll: ' +
              page.url()
            );
          }

          await page.mouse.wheel(0, 3500);
          await page.waitForTimeout(1500);

          await recogerTarjetas();
        }

        // Volvemos a comprobar la URL al terminar.
        if (!page.url().includes('/searchresults.')) {
          throw new Error(
            'Booking ha redirigido al finalizar: ' +
            page.url()
          );
        }

        const hotels = page.locator(
          '[data-testid="property-card"]'
        );

        const count = await hotels.count();

        console.log(
          'BOOKING: tarjetas visibles al finalizar:',
          count
        );

        console.log(
          'BOOKING: hoteles DOM recogidos:',
          encontradosDOM.length
        );

        // Si no hemos detectado ninguna tarjeta durante
        // todo el recorrido, repetimos la búsqueda.
        if (encontradosDOM.length === 0) {
          const diagnostico = {
            urlFinal: page.url(),
            titulo: await page.title().catch(() => ''),
            textoInicial: (
              await page.locator('body')
                .innerText()
                .catch(() => '')
            ).slice(0, 1000)
          };

          console.log(
            'DIAGNOSTICO BOOKING:',
            JSON.stringify(diagnostico)
          );

          throw new Error(
            'No se han detectado tarjetas de hoteles'
          );
        }

        // Extracción de datos incluidos en scripts.
        // Se mantiene el método de tu código anterior.
        const datosEmbebidos = await page.evaluate(() => {
          const resultados = [];

          const texto = Array.from(
            document.querySelectorAll('script')
          )
            .map((s) => s.textContent || '')
            .filter(Boolean)
            .join('\n');

          const fragmentos = texto.split('priceBreakdown');

          for (const frag of fragmentos) {
            const trozo = frag.slice(0, 2000);

            const nombreMatch =
              trozo.match(/"name"\s*:\s*"([^"]+)"/) ||
              trozo.match(/"title"\s*:\s*"([^"]+)"/) ||
              trozo.match(/"hotel_name"\s*:\s*"([^"]+)"/);

            const strikeMatch =
              trozo.match(
                /"strikethroughPrice"\s*:\s*\{[\s\S]*?"formattedAmount"\s*:\s*"([^"]+)"/
              ) ||
              trozo.match(
                /"strikethroughPrice"\s*:\s*\{[\s\S]*?"formattedRoundedAmount"\s*:\s*"([^"]+)"/
              );

            const headlineMatch =
              trozo.match(
                /"headlinePrice"\s*:\s*\{[\s\S]*?"formattedAmount"\s*:\s*"([^"]+)"/
              ) ||
              trozo.match(
                /"headlinePrice"\s*:\s*\{[\s\S]*?"formattedRoundedAmount"\s*:\s*"([^"]+)"/
              );

            if (
              nombreMatch &&
              (strikeMatch || headlineMatch)
            ) {
              resultados.push({
                nombre: nombreMatch[1],
                precioOriginal: strikeMatch
                  ? strikeMatch[1]
                  : null,
                precioActual: headlineMatch
                  ? headlineMatch[1]
                  : null,
                fuente: 'script-regex'
              });
            }
          }

          return resultados;
        });

        const encontradosScripts = datosEmbebidos.map(
          (h) => ({
            nombre: h.nombre,
            nombreLower: normalizarNombre(h.nombre),
            precioOriginal: limpiarPrecio(h.precioOriginal),
            precioActual: limpiarPrecio(h.precioActual),
            precio: limpiarPrecio(
              h.precioOriginal || h.precioActual
            ),
            fuente: h.fuente || 'script'
          })
        );

        const resultadoFinal = [];

        for (const buscado of hotelesBuscados) {
          const buscadoNorm = normalizarNombre(buscado);

          const encontradoScript = encontradosScripts.find(
            (h) => h.nombreLower.includes(buscadoNorm)
          );

          const encontradoDOM = encontradosDOM.find(
            (h) => h.nombreLower.includes(buscadoNorm)
          );

          const elegido =
            (
              encontradoScript &&
              (
                encontradoScript.precioOriginal ||
                encontradoScript.precioActual
              )
            )
              ? encontradoScript
              : encontradoDOM || encontradoScript || null;

          resultadoFinal.push({
            hotel: buscado,
            nombre: elegido ? elegido.nombre : buscado,
            precio: elegido ? elegido.precio : null,
            precio_original: elegido
              ? (
                  elegido.precioOriginal ||
                  elegido.precioActual
                )
              : null,
            precio_actual: elegido
              ? elegido.precioActual
              : null,
            fuente: elegido ? elegido.fuente : null
          });
        }

        console.log(
          `BOOKING: intento ${intento} completado`
        );

        console.log(
          'BOOKING: hoteles con precio:',
          resultadoFinal
            .filter((h) => h.precio !== null)
            .map((h) => h.hotel)
            .join(', ') || 'ninguno'
        );

        return res.status(200).json({
          ok: true,
          totalCardsDetectadas: count,
          encontradosScript: encontradosScripts.length,
          hoteles: resultadoFinal,
          intentos: intento
        });

      } catch (error) {
        ultimoError = error.message;

        console.log(
          `BOOKING: fallo en intento ${intento}:`,
          ultimoError
        );

      } finally {
        if (context) {
          await context.close().catch(() => {});
        }
      }

      if (intento < MAX_INTENTOS) {
        console.log(
          'BOOKING: esperando antes del siguiente intento'
        );

        await esperar(3000);
      }
    }

    // Si fallan los tres intentos, Make recibe
    // la misma estructura de hoteles con null.
    console.log(
      'BOOKING: agotados los intentos:',
      ultimoError
    );

    return res.status(200).json({
      ok: true,
      totalCardsDetectadas: 0,
      encontradosScript: 0,
      hoteles: resultadoVacio(),
      intentos: MAX_INTENTOS
    });

  } catch (error) {
    console.log(
      'BOOKING: error general:',
      error.message
    );

    // También devolvemos HTTP 200 para mantener
    // la continuidad del escenario de Make.
    return res.status(200).json({
      ok: true,
      totalCardsDetectadas: 0,
      encontradosScript: 0,
      hoteles: resultadoVacio(),
      intentos: 0
    });

  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on ${PORT}`);
});
