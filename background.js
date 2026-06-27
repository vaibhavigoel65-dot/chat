// background.js — GEM Product Exporter v13
// Three confirmed bugs fixed:
// 1. Brand filter: use URL brand param instead of fragile DOM text matching
// 2. Price/Availability/Seller: scraped from the styled div box, not just tables
// 3. Product ID: read from "Product id:" label in the page, not from URL

const DATA_KEY   = 'gem_cumulative_products';
const STATUS_KEY = 'gem_scrape_status';

let status = {
  running: false, brand: '', search: '',
  done: 0, total: 0, message: '', type: 'info', finishedAt: null
};

async function saveStatus() { await chrome.storage.local.set({ [STATUS_KEY]: status }); }
function broadcast() { chrome.runtime.sendMessage({ type: 'PROGRESS', status }).catch(() => {}); }
async function setStatus(patch) { status = { ...status, ...patch }; await saveStatus(); broadcast(); }

chrome.alarms.create('gem-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitForTabLoad(tabId, timeout = 25000) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, timeout);
    chrome.tabs.onUpdated.addListener(function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

async function loadSaved() { const r = await chrome.storage.local.get([DATA_KEY]); return r[DATA_KEY] || []; }
async function saveToDB(p) { await chrome.storage.local.set({ [DATA_KEY]: p }); }
async function clearDB() { await chrome.storage.local.remove([DATA_KEY]); }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_STATUS') { sendResponse(status); return; }
  if (msg.type === 'START_SCRAPE') {
    if (status.running) { sendResponse({ ok: false, error: 'Already running.' }); return; }
    sendResponse({ ok: true });
    runScrape(msg.brand, msg.search, msg.listingUrl);
    return;
  }
  if (msg.type === 'CLEAR_DATA') { clearDB().then(() => sendResponse({ ok: true })); return true; }
  if (msg.type === 'EXPORT_DATA') {
    (async () => {
      const saved = await loadSaved();
      if (!saved.length) { sendResponse({ ok: false, error: 'No data yet.' }); return; }
      downloadExcel(saved, saved[0]?._meta?.brand || 'GEM', saved[0]?._meta?.search || 'Products');
      sendResponse({ ok: true, count: saved.length });
    })();
    return true;
  }
});

// Extract only the real product ID from the URL.
// GEM URL: /p-SELLERID-PRODUCTID-cat.html
// The SECOND number is the actual product ID shown on the page.
function extractProductId(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/\/p-(\d+)-(\d+)-cat\.html/i);
  if (m) return m[2]; // m[2] = real product ID, m[1] = seller/category prefix
  return null;
}

// Build the brand-filtered listing URL.
// GEM listing pages accept a `brands` query param — this is the most reliable filter.
// e.g. https://mkp.gem.gov.in/smooth-bore-.../s?brands=ariette
// We detect the brand param key used by the current URL and inject the brand value.
function buildBrandUrl(listingUrl, brand) {
  try {
    const url = new URL(listingUrl);
    // GEM uses ?brands=X or &brands=X in its filter URLs
    // If user already has a brand filter applied, replace it; otherwise add it.
    url.searchParams.set('brands', brand);
    // Reset to page 1
    url.searchParams.delete('page');
    url.searchParams.delete('pageNo');
    return url.toString();
  } catch (_) {
    return listingUrl;
  }
}

async function runScrape(brand, search, listingUrl) {
  if (!listingUrl || !listingUrl.includes('gem.gov.in')) {
    await setStatus({ running: false, message: 'Navigate to a GEM listing page first.', type: 'error' });
    return;
  }

  await setStatus({ running: true, brand, search, done: 0, total: 0, message: 'Opening scraping window...', type: 'info' });

  // KEY FIX: Use GEM's own brand filter URL param so the page only shows the target brand.
  // This is far more reliable than DOM text matching.
  const brandFilteredUrl = buildBrandUrl(listingUrl, brand);

  let scrapeWin = null, scrapeTab = null;
  try {
    scrapeWin = await chrome.windows.create({ url: brandFilteredUrl, state: 'minimized', focused: false });
    scrapeTab = scrapeWin.tabs[0];
    await waitForTabLoad(scrapeTab.id);
    await sleep(4000);

    // ── Collect links across all pages ────────────────────────────────────
    const allLinks = new Map(); // productId -> url
    let pageNum = 1;

    while (true) {
      await setStatus({ message: `Collecting page ${pageNum} links for "${brand}"...` });

      // Scroll to ensure all cards on this page are rendered
      await chrome.scripting.executeScript({ target: { tabId: scrapeTab.id }, func: smoothScrollToBottom });
      await sleep(2000);
      await chrome.scripting.executeScript({ target: { tabId: scrapeTab.id }, func: () => window.scrollTo(0, 0) });
      await sleep(500);

      // Collect ALL product links on this page — brand filter is handled by the URL param
      const linksRes = await chrome.scripting.executeScript({
        target: { tabId: scrapeTab.id },
        func: collectAllProductLinksOnPage,
      });
      const pageLinks = linksRes[0]?.result || [];
      let newOnPage = 0;
      for (const url of pageLinks) {
        const pid = extractProductId(url);
        if (pid && !allLinks.has(pid)) { allLinks.set(pid, url); newOnPage++; }
      }

      await setStatus({ message: `Page ${pageNum}: +${newOnPage} products (total ${allLinks.size} so far)...` });

      // Try next page
      const nextRes = await chrome.scripting.executeScript({
        target: { tabId: scrapeTab.id },
        func: clickNextPage,
      });
      if (!nextRes[0]?.result) break;
      pageNum++;
      await waitForTabLoad(scrapeTab.id);
      await sleep(3000);
    }

    const productLinks = [...allLinks.entries()]; // [[pid, url], ...]

    if (!productLinks.length) {
      await setStatus({
        running: false,
        message: `No products found for brand "${brand}". Check that the brand name matches exactly as shown on GEM (e.g. "ariette"). You can verify by applying the brand filter on the GEM listing page manually first, then click Scrape.`,
        type: 'error'
      });
      chrome.windows.remove(scrapeWin.id);
      return;
    }

    await setStatus({ total: productLinks.length, message: `Found ${productLinks.length} products for "${brand}". Scraping details...` });

    const savedProducts = await loadSaved();
    const existingIds   = new Set(savedProducts.map(p => p['_pid']));
    const newProducts   = [];

    for (let i = 0; i < productLinks.length; i++) {
      const [pid, url] = productLinks[i];
      await setStatus({ done: i + 1, message: `Scraping product ${i + 1} of ${productLinks.length}...` });
      if (existingIds.has(pid)) continue;

      try {
        await chrome.tabs.update(scrapeTab.id, { url });
        await waitForTabLoad(scrapeTab.id);
        await sleep(3000);
        await chrome.scripting.executeScript({ target: { tabId: scrapeTab.id }, func: waitForProductPage });
        await sleep(500);

        const res = await chrome.scripting.executeScript({
          target: { tabId: scrapeTab.id },
          func: scrapeProductPage,
          args: [brand, search, url, pid],
        });
        const data = res[0]?.result;
        if (data) { existingIds.add(pid); newProducts.push(data); }
      } catch (e) {
        newProducts.push({ _url: url, _pid: pid, _meta: { brand, search }, 'Product ID': pid, 'Error': e.message });
        existingIds.add(pid);
      }
    }

    chrome.windows.remove(scrapeWin.id);
    const allProducts = [...savedProducts, ...newProducts];
    allProducts.forEach(p => { if (!p._meta) p._meta = { brand, search }; });
    await saveToDB(allProducts);
    downloadExcel(allProducts, brand, search);

    await setStatus({
      running: false,
      message: `✅ Done! ${newProducts.length} new + ${savedProducts.length} existing = ${allProducts.length} total.`,
      type: 'success', finishedAt: Date.now()
    });

  } catch (err) {
    if (scrapeWin) { try { chrome.windows.remove(scrapeWin.id); } catch (_) {} }
    await setStatus({ running: false, message: 'Error: ' + err.message, type: 'error' });
  }
}

// ── INJECTED: Smooth scroll ───────────────────────────────────────────────────
function smoothScrollToBottom() {
  return new Promise(resolve => {
    const step = () => {
      const before = window.scrollY;
      window.scrollBy(0, 600);
      setTimeout(() => {
        if (window.scrollY === before || window.scrollY + window.innerHeight >= document.body.scrollHeight - 50) {
          window.scrollTo(0, document.body.scrollHeight);
          resolve();
        } else { step(); }
      }, 150);
    };
    step();
  });
}

// ── INJECTED: Collect all product links on the current listing page ───────────
// No brand filtering here — the URL already has ?brands=X applied.
// We just grab every -cat.html link on the page.
function collectAllProductLinksOnPage() {
  const found = new Map();
  document.querySelectorAll('a[href]').forEach(a => {
    const href = (a.href || '').split('#')[0];
    if (!href.includes('gem.gov.in')) return;
    if (!href.includes('-cat.html') && !/\/p-\d+-\d+/.test(href)) return;
    found.set(href, true);
  });
  return [...found.keys()];
}

// ── INJECTED: Click next page ─────────────────────────────────────────────────
function clickNextPage() {
  // Try ">" / "›" buttons in pagination — GEM shows [< 1 2 >] style
  for (const el of document.querySelectorAll('a, button, li')) {
    if (!el.offsetParent) continue;
    const t = (el.innerText || el.textContent || '').trim();
    if (t !== '>' && t !== '›' && t !== 'Next' && t !== '»') continue;
    if (el.classList.contains('disabled') || el.hasAttribute('disabled')) continue;
    // Make sure it's inside a pagination container
    const inPagination = el.closest('[class*="pagination"],[class*="pager"],[class*="page-nav"]');
    if (!inPagination) continue;
    el.click();
    return true;
  }

  // Fallback: any visible pagination "next" link
  const next = document.querySelector(
    '.pagination .next:not(.disabled) a,' +
    '[class*="pagination"] [class*="next"]:not([disabled]),' +
    'a[aria-label="Next"], a[aria-label="next"],' +
    'button[aria-label="Next page"]'
  );
  if (next && next.offsetParent) { next.click(); return true; }
  return false;
}

// ── INJECTED: Wait for product page to fully load ─────────────────────────────
function waitForProductPage() {
  return new Promise(resolve => {
    // Wait until we see the price box text rendered
    const isReady = () => {
      const t = document.body.innerText || '';
      return t.includes('MRP/Unit') || t.includes('Offer Price') || t.includes('Product id');
    };
    if (isReady()) { resolve(); return; }
    let done = false;
    const obs = new MutationObserver(() => {
      if (isReady() && !done) { done = true; obs.disconnect(); resolve(); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); resolve(); }, 12000);
  });
}

// ── INJECTED: Scrape one product page ────────────────────────────────────────
// From actual screenshots, GEM product page structure:
//
// <h1>Product Name</h1>
// <p>brand name / (BRAND)</p>   ← brand shown as text below h1
//
// "Product Details" section — rendered as a STYLED BOX (not a plain table in some GEM versions),
// with rows like:
//   Price For :    1 pieces
//   MRP/Unit:      ₹ 1,450.00
//   Offer Price/Unit: ₹ 149.00
//   Availability:  6500 In Stock
//   Min. Qty. Per Consignee: 350
//   Product id:    66029781839        ← THIS is the real product ID (no prefix)
//   Country Of Origin: India
//   Local Content (MII): 100%
//
// "Seller Details" section:
//   Sold by: OEM
//   OEM verified catalogue: ✓
//   Seller Excellence: 4.0-4.49
//
// Then standard spec tables: GENERAL FEATURES, PRODUCT INFORMATIONS, MATERIAL,
// PACKING, CERTIFICATION, SHELF LIFE, ADVANCE SAMPLE, ADDITIONAL REQUIREMENTS
//
// Key insight: "Product Details" box rows are NOT always in <table> — GEM renders
// them as <div> or Angular component rows. We scan ALL text nodes for label:value pairs.

function scrapeProductPage(brandName, searchTerm, pageUrl, fallbackPid) {
  const result = {
    _url: pageUrl,
    _pid: fallbackPid,
    _meta: { brand: brandName, search: searchTerm },
    'Brand': brandName,
    'Product ID': '',
    'Product Name': '',
    'Price For': '',
    'MRP/Unit': '',
    'Offer Price/Unit': '',
    'Availability': '',
    'Min. Qty. Per Consignee': '',
    'Country Of Origin': '',
    'Local Content (MII)': '',
    'Seller': '',
  };

  function txt(el) {
    if (!el) return '';
    return (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
  }
  function clean(s) { return String(s || '').trim().replace(/\s+/g, ' '); }

  // ── 1. Product Name ───────────────────────────────────────────────────────
  const h1 = document.querySelector('h1');
  if (h1) result['Product Name'] = txt(h1);

  // ── 2. Scan EVERY row-like element for label:value pairs ──────────────────
  // GEM "Product Details" box uses div rows, not always a <table>.
  // We look for any element whose text matches "Label: Value" pattern,
  // OR any two-sibling pair where first is label and second is value.

  // Strategy A: scan all <tr> rows in tables (catches spec tables)
  const skipTags = new Set(['HEADER', 'NAV', 'FOOTER']);
  document.querySelectorAll('table tr').forEach(row => {
    let el = row.parentElement;
    while (el && el !== document.body) {
      if (skipTags.has(el.tagName)) return;
      el = el.parentElement;
    }
    const cells = [...row.querySelectorAll('td, th')];
    if (cells.length === 2) {
      const k = clean(txt(cells[0])).replace(/:$/, '');
      const v = clean(txt(cells[1]));
      if (k && v && k.length < 300 && v.length < 2000 && !result[k]) result[k] = v;
    }
    if (cells.length === 4) {
      const k1 = clean(txt(cells[0])).replace(/:$/, '');
      const v1 = clean(txt(cells[1]));
      const k2 = clean(txt(cells[2])).replace(/:$/, '');
      const v2 = clean(txt(cells[3]));
      if (k1 && v1 && !result[k1]) result[k1] = v1;
      if (k2 && v2 && !result[k2]) result[k2] = v2;
    }
  });

  // Strategy B: scan div/li rows that GEM uses for the Product Details box.
  // These are elements with exactly two child spans/divs — one label, one value.
  document.querySelectorAll('div, li').forEach(el => {
    const children = [...el.children].filter(c => c.offsetParent !== null || c.innerText?.trim());
    if (children.length !== 2) return;
    const k = clean(txt(children[0])).replace(/:$/, '');
    const v = clean(txt(children[1]));
    // Must look like a real label (not too long, no newlines in key)
    if (!k || k.length > 150 || k.includes('\n')) return;
    if (!v || v.length > 2000) return;
    // Skip navigation/breadcrumb noise
    if (/^(home|back|login|search|next|prev)$/i.test(k)) return;
    if (!result[k]) result[k] = v;
  });

  // ── 3. Targeted overrides — exact label strings from GEM screenshots ──────
  // We re-scan everything and force the canonical field names.
  // GEM label text confirmed from screenshots (some have trailing colon, some don't):
  const FIELD_MAP = {
    'price for':             'Price For',
    'mrp/unit':              'MRP/Unit',
    'offer price/unit':      'Offer Price/Unit',
    'availability':          'Availability',
    'min. qty. per consignee': 'Min. Qty. Per Consignee',
    'product id':            'Product ID',   // GEM shows "Product id" (lowercase d)
    'country of origin':     'Country Of Origin',
    'local content (mii)':   'Local Content (MII)',
    'sold by':               'Seller',
    'oem verified catalogue':'OEM Verified Catalogue',
    'seller excellence':     'Seller Excellence',
  };

  // Scan ALL elements whose direct text content looks like a label
  // by checking every parent-child text pair on the page.
  // We use TreeWalker to read text nodes and their neighbours.
  function scanLabelsInElement(root) {
    if (!root) return;
    // Get all text nodes
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim().replace(/\s+/g, ' ').replace(/:$/, '').toLowerCase();
      const canonical = FIELD_MAP[text];
      if (!canonical) continue;

      // Found a label text node. The value is in the next sibling text node or parent's next sibling.
      let valueEl = node.parentElement?.nextElementSibling;
      if (!valueEl) valueEl = node.parentElement?.parentElement?.nextElementSibling;
      if (valueEl) {
        const val = clean(txt(valueEl));
        if (val && val.length < 500) {
          result[canonical] = val; // override — this is the most targeted match
        }
      }
    }
  }
  scanLabelsInElement(document.body);

  // ── 4. Product ID — read from page label, NOT from URL ───────────────────
  // URL format: /p-SELLERID-REALPRODUCTID-cat.html
  // The page shows "Product id: 66029781839" — that's the real ID.
  // Our scanLabelsInElement above should have caught it.
  // If not, fall back to the second number in the URL.
  if (!result['Product ID'] || result['Product ID'] === '') {
    const m = pageUrl.match(/\/p-\d+-(\d+)-cat\.html/i);
    if (m) result['Product ID'] = m[1];
    else result['Product ID'] = fallbackPid;
  }

  // Update _pid to match the real product ID
  result._pid = result['Product ID'] || fallbackPid;

  return result;
}

// ── Excel download ────────────────────────────────────────────────────────────
function downloadExcel(products, brand, search) {
  const INTERNAL = new Set(['_url', '_pid', '_meta']);
  function skip(k) {
    if (INTERNAL.has(k)) return true;
    if (/^https?:\/\//.test(k)) return true;
    if (/<[a-z]/i.test(k)) return true;
    return false;
  }

  const PRIORITY = [
    'Brand', 'Product ID', 'Product Name',
    'Price For', 'MRP/Unit', 'Offer Price/Unit',
    'Availability', 'Min. Qty. Per Consignee',
    'Country Of Origin', 'Local Content (MII)',
    'Product Description', 'Purpose', 'Usage',
    'Usable for spontaneous and controlled ventilation',
    'Sterility', 'Utility', 'Method of Sterilisation', 'Autoclavable',
    'Tube Size (ID)', 'Length (mm)', 'Reservoir bag', 'Reservoir bag type',
    'Reservoir bag size to allow respiratory monitoring and /or assistance (ml)',
    'Minimum dead space and low resistance to flow',
    'Parallel entry of fresh Gas line at the patient connection',
    'Fixed elbow and luer lock port for safe monitoring at the patient end',
    'Expiratory valve at the patient end',
    'Double swivel elbow elastomeric cap at patient end',
    'Accurate and adjustable pressure limiting valve with safety feature',
    'Pressure adjustment range of pressure limiting value (kg/cm2)',
    'Suitable adaptors to connect to various parts of breathing system, flow meter etc',
    'Y-piece connector with port', 'Humidification limb',
    'Facility for incorporating inline Nebulizer / Metered Dose Inhaler (MDI)',
    'Material of tube', 'Kink resistant tube',
    'Material of the reservoir bag', 'Reservoir Bag Properties',
    'Type of packing',
    'Seller', 'OEM Verified Catalogue', 'Seller Excellence',
    'Compliance to Medical Device Rule (MDR) 2017 as amended till date',
    'Availability of valid medical device license for the product issued from the competent authority defined under Drugs and Cosmetic Act 1940 and Rules made there under as amended till date',
    'Valid Medical Device License Number',
    'Manufacturing unit certification',
    'Additional Voluntary Certification Available',
    'Availability of Test Report for each supplied batch/product as per Medical Device Rule (MDR) 2017 as amended till date',
    'Submission of all necessary certifications, licenses and test reports to the buyer at the time of bid submission or along with supplies as per buyer requirement',
    'Shelf life from the date of manufacture (in months)',
    'Minimum shelf life of the product at the time of delivery to the consignee',
    "Agree to provide advance sample of the product for buyer's approval before commencement of supply in case of bidding",
    'Additional Requirements', 'Error',
  ];

  const allKeys = new Set(products.flatMap(p => Object.keys(p)));
  const rest = [...allKeys].filter(k => !skip(k) && !PRIORITY.includes(k)).sort();
  const cols = [...PRIORITY, ...rest].filter(k => !skip(k) && products.some(p => p[k] != null && String(p[k]).trim() !== ''));

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const colW = c => {
    if (['Product Description','Purpose','Submission','Suitable adaptors','Compliance','Availability of valid','Availability of Test'].some(p => c.startsWith(p))) return '300px';
    if (['Brand','Product ID','Sterility','Autoclavable','Type of packing','Availability','Country Of Origin'].includes(c)) return '120px';
    return '170px';
  };

  const dateStr = new Date().toLocaleDateString('en-IN');
  const names = [...new Set(products.map(p => p['Product Name']).filter(Boolean))];
  const nameStr = names.length <= 3 ? names.join(' | ') : names.slice(0, 3).join(' | ') + ` + ${names.length - 3} more`;

  let html = `<html xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:x="urn:schemas-microsoft-com:office:excel"
  xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="UTF-8">
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
<x:Name>GEM Products</x:Name><x:WorksheetOptions><x:DisplayGridlines/>
</x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
<style>
body{font-family:Calibri,Arial,sans-serif;font-size:11pt}
table{border-collapse:collapse}
td,th{border:1px solid #B0C4DE;padding:5px 8px;vertical-align:top;word-wrap:break-word}
.hdr1 td{font-size:14pt;font-weight:bold;color:#fff;background:#1F3864;padding:10px 12px;border:none}
.hdr2 td{font-size:10pt;color:#1F3864;background:#DEEAF1;padding:6px 12px;border:none}
.hdr3 td{font-size:9pt;color:#5a7a9a;background:#EBF3FB;padding:4px 12px;border:none}
th{background:#1F3864;color:#fff;font-weight:bold;font-size:10pt;white-space:nowrap}
tr:nth-child(even) td{background:#EBF3FB}
tr:nth-child(odd) td{background:#fff}
</style></head><body>
<table>
<colgroup>${cols.map(c => `<col style="width:${colW(c)}">`).join('')}</colgroup>
<tr class="hdr1"><td colspan="${cols.length}">Brand: ${esc(brand)}</td></tr>
<tr class="hdr2"><td colspan="${cols.length}">Product: ${esc(search)}${nameStr ? ' — ' + esc(nameStr) : ''}</td></tr>
<tr class="hdr3"><td colspan="${cols.length}">Total: ${products.length} products  |  Exported: ${dateStr}</td></tr>
<tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr>
`;
  products.forEach(p => {
    html += `<tr>${cols.map(c => `<td>${esc(p[c] ?? '')}</td>`).join('')}</tr>\n`;
  });
  html += '</table></body></html>';

  const ts = new Date().toISOString().slice(0, 10);
  chrome.downloads.download({
    url: 'data:application/vnd.ms-excel;charset=utf-8;base64,' + btoa(unescape(encodeURIComponent(html))),
    filename: `GEM_${brand.replace(/\s+/g, '_')}_${search.replace(/\s+/g, '_')}_${ts}.xls`,
    saveAs: false,
  });
}
