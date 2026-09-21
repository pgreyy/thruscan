// extension/src/content.js
//
// The bridge between a web page and the wallet. It runs beside the page (in
// Chrome's isolated world), so the page cannot touch it, and it only ever
// carries messages both ways: requests from window.thru to the wallet, answers
// and events back. It never sees a key.

const FROM_PAGE = 'thruscan-wallet:page'
const TO_PAGE = 'thruscan-wallet:content'

window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.target !== FROM_PAGE) return
  const { id, method, params } = e.data
  let answered = false
  const answer = (payload) => {
    if (answered) return
    answered = true
    window.postMessage({ target: TO_PAGE, id, ...payload }, window.location.origin)
  }
  try {
    chrome.runtime.sendMessage({ channel: 'site', method, params }, (res) => {
      if (chrome.runtime.lastError) return answer({ ok: false, error: 'The wallet did not answer. Reload the page and try again.' })
      answer(res ?? { ok: false, error: 'No answer from the wallet.' })
    })
  } catch {
    // The extension was reloaded or removed while this page stayed open.
    answer({ ok: false, error: 'The wallet was updated. Reload the page.' })
  }
})

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // The wallet popup asking which site this tab is on.
  if (msg?.from === 'thruscan-wallet-popup' && msg.ask === 'origin') {
    if (sender.id === chrome.runtime.id) reply({ origin: window.location.origin })
    return
  }
  if (msg?.from !== 'thruscan-wallet') return
  if (msg.origin && msg.origin !== window.location.origin) return
  window.postMessage({ target: TO_PAGE, event: msg.event, data: msg.data ?? null }, window.location.origin)
})
