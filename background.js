// Injects the scraper into the current tab when the toolbar icon is clicked.
// Uses activeTab, so no scary "read all sites" permission is needed —
// it only touches a page after you click the icon on it.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['scraper.js'],
    });
  } catch (e) {
    // chrome:// pages, the web store, PDFs etc. cannot be injected — ignore.
    console.warn('Table Scraper: cannot inject here.', e);
  }
});
