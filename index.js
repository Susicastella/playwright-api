const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Playwright server OK');
});

app.post('/scrape', async (req, res) => {
  const { url } = req.body;

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

  if (!url) {
    return res.status(400).json({
      ok: false,
      error: 'Falta url'
    });
  }

  let browser;

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

  const extraerImporte = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    return (
      obj?.userAmount?.formattedAmount ||
      obj?.userAmount?.formattedRoundedAmount ||
      obj?.formattedAmount ||
      obj?.formattedRoundedAmount ||
      obj?.amount ||
      null
    );
  };

  const recorrer = (value, visit, seen = new WeakSet()) => {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);

    visit(value);

    if (Array.isArray(value)) {
      for (const item of value) recorrer(item, visit, seen);
      return;
    }

    for (const key of Object.keys(value)) {
      recorrer(value[key], visit, seen);
    }
  };

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'es-ES'
    });

    const page = await context.newPage();

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForTimeout(4000);

    const btnCookies = page.locator('button:has-text("Aceptar")');
    if (await btnCookies.count() > 0) {
      await btnCookies.first().click().catch(() => {});
    }

    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(6000);

    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, 3500);
      await page.waitForTimeout(2500);
    }

    // 1) Intentar extraer precios desde scripts / datos embebidos
    const datosEmbebidos = await page.evaluate(() => {
      const resultados = [];

      const extraerTextoScripts = () => {
        const scripts = Array.from(document.querySelectorAll('script'));
        return scripts
          .map((s) => s.textContent || '')
          .filter(Boolean)
          .join('\n');
      };

      const texto = extraerTextoScripts();

      // Intento 1: buscar nombres de hotel cerca de priceBreakdown en texto bruto
      // Esto no es perfecto, pero ayuda cuando Booking deja datos serializados en scripts.
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

        if (nombreMatch && (strikeMatch || headlineMatch)) {
          resultados.push({
            nombre: nombreMatch[1],
            precioOriginal: strikeMatch ? strikeMatch[1] : null,
            precioActual: headlineMatch ? headlineMatch[1] : null,
            fuente: 'script-regex'
          });
        }
      }

      return resultados;
    });

    // 2) Extraer desde DOM visible como respaldo
    const hotels = page.locator('[data-testid="property-card"]');
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
          const txt = await loc.innerText().catch(() => '');
          if (txt && /\d/.test(txt)) {
            precioOriginalTxt = txt;
            break;
          }
        }
      }

      precioActualTxt = await hotel
        .locator('[data-testid="price-and-discounted-price"]')
        .first()
        .innerText()
        .catch(() => '');

      encontradosDOM.push({
        nombre: name,
        nombreLower: normalizarNombre(name),
        precioOriginal: limpiarPrecio(precioOriginalTxt),
        precioActual: limpiarPrecio(precioActualTxt),
        precio: limpiarPrecio(precioOriginalTxt || precioActualTxt),
        fuente: 'dom'
      });
    }

    // 3) Normalizar datos embebidos
    const encontradosScripts = datosEmbebidos.map((h) => ({
      nombre: h.nombre,
      nombreLower: normalizarNombre(h.nombre),
      precioOriginal: limpiarPrecio(h.precioOriginal),
      precioActual: limpiarPrecio(h.precioActual),
      precio: limpiarPrecio(h.precioOriginal || h.precioActual),
      fuente: h.fuente || 'script'
    }));

    // 4) Para cada hotel buscado, priorizar script sobre DOM si el script trae original
    const resultadoFinal = [];

    for (const buscado of hotelesBuscados) {
      const buscadoNorm = normalizarNombre(buscado);

      const encontradoScript = encontradosScripts.find((h) =>
        h.nombreLower.includes(buscadoNorm)
      );

      const encontradoDOM = encontradosDOM.find((h) =>
        h.nombreLower.includes(buscadoNorm)
      );

      const elegido =
        (encontradoScript && (encontradoScript.precioOriginal || encontradoScript.precioActual))
          ? encontradoScript
          : encontradoDOM || encontradoScript || null;

      resultadoFinal.push({
        hotel: buscado,
        nombre: elegido ? elegido.nombre : buscado,
        precio: elegido ? elegido.precio : null,
        precio_original: elegido ? (elegido.precioOriginal || elegido.precioActual) : null,
        precio_actual: elegido ? elegido.precioActual : null,
        fuente: elegido ? elegido.fuente : null
      });
    }

    return res.json({
      ok: true,
      totalCardsDetectadas: count,
      encontradosScript: encontradosScripts.length,
      hoteles: resultadoFinal
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
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