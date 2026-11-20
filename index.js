
const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

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

app.get('/', (req, res) => {
  res.send('Playwright server OK');
});

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

const hotelesNulos = () =>
  hotelesBuscados.map((hotel) => ({
    hotel,
    nombre: hotel,
    precio: null,
    precio_original: null,
    precio_actual: null,
    fuente: null
  }));

function simplificarURL(urlOriginal) {
  const original = new URL(urlOriginal);
  const nueva = new URL(
    'https://www.booking.com/searchresults.html'
  );

  const parametros = [
    'ss',
    'dest_id',
    'dest_type',
    'checkin',
    'checkout',
    'group_adults',
    'no_rooms',
    'group_children',
    'lang'
  ];

  for (const parametro of parametros) {
    const valor = original.searchParams.get(parametro);
    if (valor !== null) {
      nueva.searchParams.set(parametro, valor);
    }
  }

  if (!nueva.searchParams.has('lang')) {
    nueva.searchParams.set('lang', 'es');
  }

  return nueva.toString();
}

function verificarURL(urlActual, urlOriginal) {
  try {
    const original = new URL(urlOriginal);
    const actual = new URL(urlActual);

    const esResultados =
      actual.pathname.includes('searchresults');

    const fechaEntrada =
      original.searchParams.get('checkin');

    const fechaSalida =
      original.searchParams.get('checkout');

    const fechasCorrectas =
      (!fechaEntrada ||
        actual.searchParams.get('checkin') ===
          fechaEntrada) &&
      (!fechaSalida ||
        actual.searchParams.get('checkout') ===
          fechaSalida);

    return esResultados && fechasCorrectas;
  } catch (error) {
    return false;
  }
}

// Comprobar si la navegación se resuelve sola.
// No intenta superar ni modificar desafíos de seguridad.
async function esperarNavegacion(page, urlOriginal, tiempoMaximo) {
  const inicio = Date.now();
  let primeraDeteccion = null;
  let ultimaURL = '';

  while (Date.now() - inicio < tiempoMaximo) {
    const urlActual = page.url();

    if (urlActual !== ultimaURL) {
      console.log(
        'BOOKING NAVEGACION: URL:',
        urlActual
      );
      ultimaURL = urlActual;
      primeraDeteccion = null;
    }

    if (verificarURL(urlActual, urlOriginal)) {
      const tarjetas = await page
        .locator('[data-testid="property-card"]')
        .count()
        .catch(() => 0);

      if (tarjetas > 0) {
        if (primeraDeteccion === null) {
          primeraDeteccion = Date.now();
        }

        if (Date.now() - primeraDeteccion >= 3000) {
          console.log(
            'BOOKING: resultados estables:',
            tarjetas
          );
          return true;
        }
      } else {
        primeraDeteccion = null;
      }
    }

    await page.waitForTimeout(500);
  }

  console.log(
    'BOOKING NAVEGACION: sin resultados tras',
    tiempoMaximo,
    'ms'
  );

  console.log(
    'BOOKING NAVEGACION: URL final:',
    page.url()
  );

  return false;
}

app.post('/scrape', async (req, res) => {
  const { url } = req.body || {};

  if (!url) {
    return res.status(400).json({
      ok: false,
      error: 'Falta url'
    });
  }

  let browser;
  let context;
  let page;
  let intentos = 0;

  const responderNulos = (motivo) =>
    res.status(200).json({
      ok: false,
      motivo,
      intentos,
      totalCardsDetectadas: 0,
      encontradosScript: 0,
      hoteles: hotelesNulos()
    });

  try {
    const urlAlternativa = simplificarURL(url);

    console.log('BOOKING: URL original:', url);
    console.log(
      'BOOKING: URL alternativa:',
      urlAlternativa
    );

    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ]
    });

    const crearContexto = async () =>
      browser.newContext({
        viewport: {
          width: 1366,
          height: 768
        },
        locale: 'es-ES'
      });

    let resultadoFinal = null;
    let totalCardsDetectadas = 0;
    let encontradosScriptCantidad = 0;
    let exito = false;

    // Tres intentos secuenciales
    for (let intento = 1; intento <= 3; intento++) {
      intentos = intento;

      const urlIntento =
        intento === 1 ? url : urlAlternativa;

      console.log(
        `BOOKING: intento ${intento} de 3`
      );

      try {
        if (context) {
          await context.close().catch(() => {});
        }

        context = await crearContexto();
        page = await context.newPage();

        const respuestasBooking = [];
        const navegacionesBooking = [];

        page.on('response', (response) => {
          if (!response.url().includes('booking.com')) {
            return;
          }

          if (
            response.request().isNavigationRequest() ||
            [202, 403, 429].includes(response.status())
          ) {
            respuestasBooking.push({
              estado: response.status(),
              url: response.url().slice(0, 250),
              navegacion:
                response.request().isNavigationRequest()
            });
          }
        });

        page.on('framenavigated', (frame) => {
          if (frame === page.mainFrame()) {
            navegacionesBooking.push(
              frame.url().slice(0, 250)
            );
          }
        });

        const respuesta = await page.goto(urlIntento, {
          waitUntil: 'domcontentloaded',
          timeout: 20000
        });

        const estadoInicial = respuesta
          ? respuesta.status()
          : null;

        console.log(
          'BOOKING DEBUG: estado inicial:',
          estadoInicial ?? 'sin respuesta'
        );

        const cuerpoInicial = respuesta
          ? await respuesta.body()
              .catch(() => Buffer.alloc(0))
          : Buffer.alloc(0);

        console.log(
          'BOOKING DEBUG: bytes respuesta inicial:',
          cuerpoInicial.length
        );

        if (estadoInicial === 202) {
          const html = cuerpoInicial.toString('utf8');
          const texto = html.toLowerCase();

          console.log(
            'BOOKING DEBUG 202: challenge:',
            texto.includes('challenge')
          );

          console.log(
            'BOOKING DEBUG 202: bot:',
            texto.includes('bot')
          );

          console.log(
            'BOOKING DEBUG 202: captcha:',
            texto.includes('captcha')
          );
        }

        // PRUEBA NUEVA:
        // Esperar hasta 15 segundos para comprobar
        // si Booking completa la navegación normalmente.
        // No se interviene en la verificación.
        const resultadosCargados =
          await esperarNavegacion(
            page,
            url,
            estadoInicial === 202 ? 15000 : 12000
          );

        console.log(
          'BOOKING DEBUG: URL final:',
          page.url()
        );

        console.log(
          'BOOKING DEBUG: título final:',
          await page.title().catch(() => 'sin título')
        );

        console.log(
          'BOOKING DEBUG: respuestas:',
          JSON.stringify(respuestasBooking.slice(-15))
        );

        console.log(
          'BOOKING DEBUG: navegaciones:',
          JSON.stringify(navegacionesBooking.slice(-10))
        );

        if (!resultadosCargados) {
          console.log(
            `BOOKING: intento ${intento} fallido`
          );
          continue;
        }

        // Aceptar cookies si aparece el botón
        const btnCookies = page.locator(
          'button:has-text("Aceptar")'
        );

        if (await btnCookies.count() > 0) {
          await btnCookies.first()
            .click({ timeout: 3000 })
            .catch(() => {});
        }

        // Desplazamientos para cargar más hoteles
        let redirigido = false;

        for (let i = 0; i < 8; i++) {
          if (!verificarURL(page.url(), url)) {
            redirigido = true;
            break;
          }

          await page.mouse.wheel(0, 3500);
          await page.waitForTimeout(1200);

          if (!verificarURL(page.url(), url)) {
            redirigido = true;
            break;
          }
        }

        if (redirigido) {
          console.log(
            'BOOKING: redirección durante el scroll'
          );
          continue;
        }

        // 1. Extraer precios desde scripts
        const datosEmbebidos = await page.evaluate(() => {
          const resultados = [];

          const texto = Array.from(
            document.querySelectorAll('script')
          )
            .map((s) => s.textContent || '')
            .filter(Boolean)
            .join('\n');

          const fragmentos = texto.split(
            'priceBreakdown'
          );

          for (const frag of fragmentos) {
            const trozo = frag.slice(0, 2000);

            const nombreMatch =
              trozo.match(
                /"name"\s*:\s*"([^"]+)"/
              ) ||
              trozo.match(
                /"title"\s*:\s*"([^"]+)"/
              ) ||
              trozo.match(
                /"hotel_name"\s*:\s*"([^"]+)"/
              );

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

        // 2. Extraer desde tarjetas visibles
        const hotels = page.locator(
          '[data-testid="property-card"]'
        );

        const count = await hotels.count();
        const encontradosDOM = [];

        for (let i = 0; i < count; i++) {
          const hotel = hotels.nth(i);

          const name = await hotel
            .locator('[data-testid="title"]')
            .innerText()
            .catch(() => '');

          if (!name) continue;

          let precioOriginalTxt = '';

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
              const txt = await loc
                .innerText()
                .catch(() => '');

              if (txt && /\d/.test(txt)) {
                precioOriginalTxt = txt;
                break;
              }
            }
          }

          const precioActualTxt = await hotel
            .locator(
              '[data-testid="price-and-discounted-price"]'
            )
            .first()
            .innerText()
            .catch(() => '');

          encontradosDOM.push({
            nombre: name,
            nombreLower: normalizarNombre(name),
            precioOriginal: limpiarPrecio(
              precioOriginalTxt
            ),
            precioActual: limpiarPrecio(
              precioActualTxt
            ),
            precio: limpiarPrecio(
              precioOriginalTxt || precioActualTxt
            ),
            fuente: 'dom'
          });
        }

        if (!verificarURL(page.url(), url)) {
          console.log(
            'BOOKING: redirección durante extracción'
          );
          continue;
        }

        // 3. Normalizar datos embebidos
        const encontradosScripts =
          datosEmbebidos.map((h) => ({
            nombre: h.nombre,
            nombreLower: normalizarNombre(h.nombre),
            precioOriginal: limpiarPrecio(
              h.precioOriginal
            ),
            precioActual: limpiarPrecio(
              h.precioActual
            ),
            precio: limpiarPrecio(
              h.precioOriginal || h.precioActual
            ),
            fuente: h.fuente || 'script'
          }));

        // 4. Priorizar precio original tachado
        const resultados = [];

        for (const buscado of hotelesBuscados) {
          const buscadoNorm =
            normalizarNombre(buscado);

          const encontradoScript =
            encontradosScripts.find((h) =>
              h.nombreLower.includes(buscadoNorm)
            );

          const encontradoDOM =
            encontradosDOM.find((h) =>
              h.nombreLower.includes(buscadoNorm)
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
              : encontradoDOM ||
                encontradoScript ||
                null;

          resultados.push({
            hotel: buscado,
            nombre: elegido
              ? elegido.nombre
              : buscado,
            precio: elegido
              ? elegido.precio
              : null,
            precio_original: elegido
              ? (
                  elegido.precioOriginal ||
                  elegido.precioActual
                )
              : null,
            precio_actual: elegido
              ? elegido.precioActual
              : null,
            fuente: elegido
              ? elegido.fuente
              : null
          });
        }

        resultadoFinal = resultados;
        totalCardsDetectadas = count;
        encontradosScriptCantidad =
          encontradosScripts.length;

        console.log(
          'BOOKING: tarjetas detectadas:',
          count
        );

        console.log(
          'BOOKING: hoteles con precio:',
          resultados.filter((h) => h.precio).length
        );

        exito = true;
        break;

      } catch (error) {
        console.log(
          `BOOKING: error intento ${intento}:`,
          error.message
        );
      }
    }

    if (!exito) {
      return responderNulos(
        'Booking no ha cargado resultados válidos tras tres intentos'
      );
    }

    return res.status(200).json({
      ok: true,
      intentos,
      totalCardsDetectadas,
      encontradosScript: encontradosScriptCantidad,
      hoteles: resultadoFinal
    });

  } catch (error) {
    console.error(
      'BOOKING: error general:',
      error.message
    );

    return responderNulos(error.message);

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
