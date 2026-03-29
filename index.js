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
    'hugo beach',
    'fin de semana',
    'clibomar',
    'tres anclas',
    'albatros',
    'porto',
    'san luis'
  ];

  if (!url) {
    return res.status(400).json({ ok: false, error: 'Falta url' });
  }

  try {
    const hotelesNormalizados = hotelesBuscados.map(h => h.toLowerCase().trim());

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(4000);

    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 3000);
      await page.waitForTimeout(2000);
    }

    const hotels = page.locator('[data-testid="property-card"]');
    const count = await hotels.count();

    let resultados = [];

    for (let i = 0; i < count; i++) {
      const hotel = hotels.nth(i);

      const name = await hotel.locator('[data-testid="title"]').innerText().catch(() => '');
      const price = await hotel.locator('[data-testid="price-and-discounted-price"]').innerText().catch(() => '');

      if (!name) continue;

      const nameLower = name.toLowerCase().trim();
      const coincide = hotelesNormalizados.some(hotelBuscado => nameLower.includes(hotelBuscado));

      if (coincide) {
        resultados.push({
          nombre: name,
          precio: price || null
        });
      }
    }

    await browser.close();

    return res.json({
      ok: true,
      total: resultados.length,
      hoteles: resultados
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on ${PORT}`);
});
