// popup.js — GEM Product Exporter v5
// This popup is now just a thin UI. All scraping happens in background.js,
// so the scrape keeps running even if you close this popup.

const startBtn     = document.getElementById('startBtn');
const statusEl     = document.getElementById('status');
const progressBar  = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');
const countLabel   = document.getElementById('countLabel');
const brandInput   = document.getElementById('brandName');
const searchInput  = document.getElementById('searchTerm');

function setStatus(msg, type = 'info') {
  statusEl.textContent = msg;
  statusEl.className = `status ${type}`;
}

function setProgress(done, total) {
  if (!total) { progressBar.style.display = 'none'; countLabel.style.display = 'none'; return; }
  progressBar.style.display = 'block';
  countLabel.style.display = 'block';
  const pct = Math.round((done / total) * 100);
  progressFill.style.width = pct + '%';
  countLabel.textContent = `${done} / ${total} products scraped`;
}

function renderStatus(s) {
  if (!s) return;
  if (s.message) setStatus(s.message, s.type || 'info');
  setProgress(s.done, s.total);
  if (s.running) {
    startBtn.disabled = true;
    startBtn.textContent = '⏳ Running in background...';
    if (s.brand) brandInput.value = s.brand;
    if (s.search) searchInput.value = s.search;
  } else {
    startBtn.disabled = false;
    startBtn.textContent = '▶ Scrape & Add to Sheet';
  }
}

// ── Re-sync with background on popup open, in case a scrape is mid-flight ────
chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (s) => renderStatus(s));

// ── Live updates pushed from background while popup is open ──────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'PROGRESS') renderStatus(msg.status);
});

// ── Buttons ───────────────────────────────────────────────────────────────────
document.getElementById('exportBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'EXPORT_DATA' }, (res) => {
    if (!res?.ok) { setStatus(res?.error || 'Nothing to export yet.', 'error'); return; }
    setStatus(`✅ Downloaded ${res.count} products.`, 'success');
  });
});

document.getElementById('clearBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_DATA' }, () => {
    setStatus('Saved data cleared.', 'info');
    setProgress(0, 0);
  });
});

startBtn.addEventListener('click', async () => {
  const brand  = brandInput.value.trim();
  const search = searchInput.value.trim();
  if (!brand || !search) { setStatus('Fill in both Brand and Product fields.', 'error'); return; }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const listingUrl = activeTab?.url || '';

  if (!listingUrl.includes('gem.gov.in')) {
    setStatus('Navigate to a GEM product listing page first, then click Scrape.', 'error');
    return;
  }

  chrome.runtime.sendMessage({ type: 'START_SCRAPE', brand, search, listingUrl }, (res) => {
    if (!res?.ok) { setStatus(res?.error || 'Could not start scrape.', 'error'); return; }
    setStatus('Started — you can close this popup, it keeps running in the background.', 'info');
    startBtn.disabled = true;
    startBtn.textContent = '⏳ Running in background...';
  });
});
document.getElementById("debugBtn").addEventListener("click", async () => {

    const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true
    });

    chrome.scripting.executeScript({

        target: {
            tabId: tab.id
        },

        func: debugDOM

    });

});
function debugDOM() {

    const report = {};

    report.url = location.href;

    report.title = document.title;

    report.totalLinks =
        document.querySelectorAll("a").length;

    report.tables =
        document.querySelectorAll("table").length;

    report.forms =
        document.querySelectorAll("form").length;

    report.buttons =
        [...document.querySelectorAll("button")]
        .map(x => x.innerText.trim());

    report.inputs =
        [...document.querySelectorAll("input")]
        .map(x => ({
            type: x.type,
            placeholder: x.placeholder,
            class: x.className
        }));

    report.productCards =
        [...document.querySelectorAll("*")]
        .filter(e =>
            e.querySelector("a[href*='-cat']")
        )
        .slice(0,50)
        .map(e=>({

            tag:e.tagName,

            class:e.className,

            id:e.id,

            text:e.innerText.substring(0,150)

        }));

    report.pagination =
        [...document.querySelectorAll("*")]
        .filter(e=>

            /next|page|pagination|pager/i.test(

                e.className+

                e.id+

                e.innerText

            )

        )

        .map(e=>({

            tag:e.tagName,

            class:e.className,

            text:e.innerText

        }));

    report.tablesHTML =
        [...document.querySelectorAll("table")]

        .slice(0,10)

        .map(t=>t.outerHTML);

    console.log(report);

    const blob=new Blob(

        [JSON.stringify(report,null,2)],

        {

            type:"application/json"

        }

    );

    const a=document.createElement("a");

    a.href=URL.createObjectURL(blob);

    a.download="gem_debug_report.json";

    a.click();

}
