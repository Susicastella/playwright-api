const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

const HOTEL_URL = "https://booking.hoteltresanclas.com/";

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Tres Anclas Token"
  });
});

app.get("/token-tres-anclas", async (req, res) => {

  res.set("Cache-Control", "no-store");

  if (!API_KEY || req.get("x-api-key") !== API_KEY) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
  }

  let browser;

  try {

    console.log("Iniciando Chromium...");

    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage"
      ]
    });

    const context = await browser.newContext({
      locale: "es-ES"
    });

    const page = await context.newPage();

    const tokenPromise = page.waitForResponse(
      response =>
        response.url() ===
          "https://pullapi.open-room.com/api/Token/CreateToken" &&
        response.request().method() === "POST" &&
        response.status() === 200,
      { timeout: 45000 }
    ).catch(() => null);

    console.log("Abriendo motor de reservas...");

    await page.goto(HOTEL_URL, {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });

    const response = await tokenPromise;

    if (!response) {
      return res.status(502).json({
        ok: false,
        error: "No se recibió respuesta de CreateToken",
        url_final: page.url()
      });
    }

    const data = await response.json();

    if (!data.token) {
      return res.status(502).json({
        ok: false,
        error: "La respuesta no contiene un token"
      });
    }

    console.log("Token obtenido correctamente");

    return res.json({
      ok: true,
      hotel: "Tres Anclas",
      token: data.token,
      tokenType: data.tokenType || "bearer",
      expiresInSeconds: data.expiresInSeconds || null,
      obtainedAt: new Date().toISOString()
    });

  } catch (error) {

    console.error("Error:", error.message);

    return res.status(500).json({
      ok: false,
      error: error.message
    });

  } finally {

    if (browser) {
      await browser.close().catch(() => {});
    }

    console.log("Chromium cerrado");
  }
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
