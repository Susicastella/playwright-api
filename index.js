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

    const hotels = page.locator('[data-testid="property-card"]');
    const count = await hotels.count();

    // 👉 primero recogemos TODOS los hoteles visibles
    let encontrados = [];

    for (let i = 0; i < count; i++) {
      const hotel = hotels.nth(i);

      const name = await hotel
        .locator('[data-testid="title"]')
        .innerText()
        .catch(() => '');

      const price = await hotel
        .locator('[data-testid="price-and-discounted-price"]')
        .innerText()
        .catch(() => '');

      if (!name) continue;

      encontrados.push({
        nombre: name,
        nombreLower: name.toLowerCase(),
        precio: price || null
      });
    }

    // 👉 ahora construimos resultado ORDENADO SIEMPRE
    let resultadoFinal = [];

    for (const buscado of hotelesBuscados) {
      const encontrado = encontrados.find(h =>
        h.nombreLower.includes(buscado)
      );

      resultadoFinal.push({
        hotel: buscado,
        nombre: encontrado ? encontrado.nombre : buscado,
        precio: encontrado ? encontrado.precio : null
      });
    }

    return res.json({
      ok: true,
      totalCardsDetectadas: count,
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