const puppeteer = require("puppeteer");

const SAVEFROM_URL = "https://id.savefrom.net/194kC/download-from-instagram";

/**
 * Launch Puppeteer browser dengan config optimal untuk server/Pterodactyl
 */
async function launchBrowser() {
  return await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--mute-audio",
      "--hide-scrollbars",
    ],
    timeout: 30000,
  });
}

/**
 * Scrape download links dari SaveFrom untuk URL Instagram
 * @param {string} instagramUrl - URL Instagram (post/reel/story)
 * @returns {object} - Result object dengan download links
 */
async function scrapeInstagramDownload(instagramUrl) {
  let browser = null;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    // Set user agent agar tidak terdeteksi bot
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Block resource tidak perlu (gambar, font, css) agar lebih cepat
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (["image", "font", "stylesheet", "media"].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Buka halaman SaveFrom
    await page.goto(SAVEFROM_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Tunggu input field muncul
    await page.waitForSelector('input[type="text"], input#sf_url, input.sf_input', {
      timeout: 15000,
    });

    // Cari input field yang tersedia
    const inputSelector = await page.evaluate(() => {
      const selectors = ['input#sf_url', 'input.sf_input', 'input[name="url"]', 'input[type="text"]'];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return sel;
      }
      return null;
    });

    if (!inputSelector) {
      throw new Error("Input field tidak ditemukan di halaman");
    }

    // Clear dan isi URL Instagram
    await page.click(inputSelector, { clickCount: 3 });
    await page.type(inputSelector, instagramUrl, { delay: 50 });

    // Klik tombol download/submit
    const buttonSelector = await page.evaluate(() => {
      const selectors = [
        'button[type="submit"]',
        'button.btn-submit',
        'button#sf_submit',
        'input[type="submit"]',
        'button.download-btn',
        '.sf-download-btn',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return sel;
      }
      // Fallback: cari button dengan teks Download
      const buttons = Array.from(document.querySelectorAll("button"));
      const dlBtn = buttons.find(
        (b) =>
          b.textContent.toLowerCase().includes("download") ||
          b.textContent.toLowerCase().includes("unduh")
      );
      return dlBtn ? "button" : null;
    });

    if (!buttonSelector) {
      throw new Error("Tombol submit tidak ditemukan");
    }

    // Submit dan tunggu hasil
    await Promise.all([
      page.click(buttonSelector),
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {}),
    ]);

    // Tunggu hasil muncul
    await page.waitForFunction(
      () => {
        const resultSelectors = [
          ".result-box",
          ".download-result",
          "#download-result",
          ".sf-result",
          'a[href*="instagram"]',
          'a[href*="cdninstagram"]',
          'a[href*=".mp4"]',
          'a[href*=".jpg"]',
        ];
        return resultSelectors.some((sel) => document.querySelector(sel));
      },
      { timeout: 20000 }
    ).catch(() => {});

    // Ambil semua data hasil
    const result = await page.evaluate((igUrl) => {
      const data = {
        source_url: igUrl,
        media_type: null,
        thumbnail: null,
        title: null,
        downloads: [],
        raw_links: [],
      };

      // Ambil thumbnail
      const thumbSelectors = [
        ".result-box img",
        ".download-result img",
        ".media-preview img",
        ".thumbnail img",
      ];
      for (const sel of thumbSelectors) {
        const img = document.querySelector(sel);
        if (img && img.src) {
          data.thumbnail = img.src;
          break;
        }
      }

      // Ambil judul / caption
      const titleSelectors = [".media-title", ".result-title", "h2.title", ".caption"];
      for (const sel of titleSelectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) {
          data.title = el.textContent.trim();
          break;
        }
      }

      // Ambil semua link download
      const allLinks = Array.from(document.querySelectorAll("a[href]"));
      const downloadLinks = allLinks.filter((a) => {
        const href = a.href || "";
        return (
          href.includes(".mp4") ||
          href.includes(".jpg") ||
          href.includes(".jpeg") ||
          href.includes(".png") ||
          href.includes("cdninstagram") ||
          href.includes("scontent") ||
          a.download ||
          a.textContent.toLowerCase().includes("download") ||
          a.classList.contains("download")
        );
      });

      downloadLinks.forEach((a) => {
        const href = a.href;
        const text = a.textContent.trim();
        const quality =
          a.getAttribute("data-quality") ||
          a.getAttribute("data-res") ||
          (text.match(/\d+p/i) ? text.match(/\d+p/i)[0] : null);

        let type = "unknown";
        if (href.includes(".mp4") || href.includes("video")) type = "video";
        else if (
          href.includes(".jpg") ||
          href.includes(".jpeg") ||
          href.includes(".png") ||
          href.includes("image")
        )
          type = "image";

        data.downloads.push({
          url: href,
          quality: quality || "standard",
          type: type,
          label: text || "Download",
        });
      });

      // Deteksi media type
      if (data.downloads.length > 0) {
        const hasVideo = data.downloads.some((d) => d.type === "video");
        const hasImage = data.downloads.some((d) => d.type === "image");
        if (hasVideo && hasImage) data.media_type = "carousel";
        else if (hasVideo) data.media_type = "video";
        else if (hasImage) data.media_type = "image";
      }

      // Fallback: ambil semua raw links dari halaman yang relevan
      if (data.downloads.length === 0) {
        const rawLinks = Array.from(document.querySelectorAll("a[href]"))
          .map((a) => a.href)
          .filter(
            (href) =>
              href.startsWith("http") &&
              !href.includes("savefrom") &&
              !href.includes("javascript")
          );
        data.raw_links = [...new Set(rawLinks)].slice(0, 10);
      }

      return data;
    }, instagramUrl);

    return {
      success: true,
      data: result,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      data: null,
    };
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { scrapeInstagramDownload };
