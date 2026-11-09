
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

// Construir una URL sencilla conservando los datos de Make
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

// Comprobar la página sin realizar las esperas largas
async function comprobarPagina(page, urlOriginal) {
  const original = new URL(urlOriginal);

  const fechaEntrada = original.searchParams.get('checkin');
  const fechaSalida = original.searchParams.get('checkout');

  await page.waitForTimeout(1500);

  const urlActual = page.url();
  const actual = new URL(urlActual);

  const esResultados =
    actual.pathname.includes('searchresults');

  const fechasCorrectas =
    (!fechaEntrada ||
      actual.searchParams.get('checkin') === fechaEntrada) &&
    (!fechaSalida ||
      actual.searchParams.get('checkout') === fechaSalida);

  console.log('BOOKING: URL actual:', urlActual);
  console.log('BOOKING: página de resultados:', esResultados);
  console.log('BOOKING: fechas correctas:', fechasCorrectas);

  return esResultados && fechasCorrectas;
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
    console.log('BOOKING: URL alternativa:', urlAlternativa);

    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ]
    });

    const crearContexto = async () => {
      return browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        viewport: {
          width: 1366,
          height: 768
        },
        locale: 'es-ES'
      });
    };

    context = await crearContexto();
    page = await context.newPage();

    let paginaCorrecta = false;

    for (let intento = 1; intento <= 3; intento++) {
      intentos = intento;

      const urlIntento =
        intento === 1 ? url : urlAlternativa;

      console.log(
        `BOOKING: intento ${intento} de 3`
      );

      try {
        // En el tercer intento, renovar la sesión,
        // pero mantener el mismo navegador.
        if (intento === 3) {
          await context.close().catch(() => {});

          context = await crearContexto();
          page = await context.newPage();
        }

        await page.goto(urlIntento, {
          waitUntil: 'domcontentloaded',
          timeout: 20000
        });

        paginaCorrecta = await comprobarPagina(
          page,
          url
        );

        if (paginaCorrecta) {
          console.log(
            `BOOKING: intento ${intento} correcto`
          );
          break;
        }

        console.log(
          `BOOKING: intento ${intento} redirigido`
        );
      } catch (error) {
        console.log(
          `BOOKING: fallo en intento ${intento}:`,
          error.message
        );
      }
    }

    if (!paginaCorrecta) {
      return responderNulos(
        'Booking no ha cargado la búsqueda con las fechas correctas'
      );
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

    // Esperar a que aparezcan las tarjetas de hoteles
    await page
      .locator('[data-testid="property-card"]')
      .first()
      .waitFor({
        state: 'attached',
        timeout: 10000
      })
      .catch(() => {});

    // Desplazarse para cargar más hoteles
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, 3500);
      await page.waitForTimeout(1500);
    }

    // Si Booking redirige después, no extraer
    // precios de una página incorrecta.
    const sigueCorrecta = await comprobarPagina(
      page,
      url
    );

    if (!sigueCorrecta) {
      return responderNulos(
        'Booking ha redirigido durante la carga de resultados'
      );
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

      const fragmentos = texto.split('priceBreakdown');

      for (const frag of fragmentos) {
        const trozo = frag.slice(0, 2000);

        const nombreMatch =
          trozo.match(/"name"\s*:\s*"([^"]+)"/) ||
          trozo.match(/"title"\s*:\s*"([^"]+)"/) ||
          trozo.match(/"hotel_name"\s*:\s*"([^"]+)"/);

        const strikeMatch =
          trozo.match(/"strikethroughPrice"\s*:\s*\{[\s\S]*?"formattedAmount"\s*:\s*"([^"]+)"/) ||
          trozo.match(/"strikethroughPrice"\s*:\s*\{[\s\S]*?"formattedRoundedAmount"\s*:\s*"([^"]+)"/);

        const headlineMatch =
          trozo.match(/"headlinePrice"\s*:\s*\{[\s\S]*?"formattedAmount"\s*:\s*"([^"]+)"/) ||
          trozo.match(/"headlinePrice"\s*:\s*\{[\s\S]*?"formattedRoundedAmount"\s*:\s*"([^"]+)"/);

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

    // 2. Extraer precios desde las tarjetas visibles
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

    // 3. Normalizar datos de scripts
    const encontradosScripts = datosEmbebidos.map(
      (h) => ({
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
      })
    );

    // 4. Priorizar precio original tachado
    const resultadoFinal = [];

    for (const buscado of hotelesBuscados) {
      const buscadoNorm = normalizarNombre(
        buscado
      );

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
          : encontradoDOM || encontradoScript || null;

      resultadoFinal.push({
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

    console.log(
      'BOOKING: tarjetas detectadas:',
      count
    );

    console.log(
      'BOOKING: hoteles con precio:',
      resultadoFinal.filter((h) => h.precio).length
    );

    return res.status(200).json({
      ok: true,
      intentos,
      totalCardsDetectadas: count,
      encontradosScript: encontradosScripts.length,
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
