## 2024-04-24 - XSS via innerHTML and Unsafe Escaping
**Vulnerability:** User input was rendered into the DOM using `.innerHTML` combined with a custom `esc()` escaping mechanism in the `showWinBanner` and `renderSearchResults` functions.
**Learning:** Depending solely on manual string escaping via custom functions combined with `.innerHTML` is error-prone. Safe DOM traversal (`document.createElement`, `.textContent`, `.appendChild`) offers robust protections against XSS out-of-the-box as it inherently prevents HTML execution for text assignments.
**Prevention:** Always default to safe DOM methods (`document.createElement()`, `element.textContent`, etc.) over string interpolations rendered via `.innerHTML` for any dynamic values.
