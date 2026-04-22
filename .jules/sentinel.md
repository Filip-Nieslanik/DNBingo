## Sentinel's Journal
## 2024-05-24 - Enhance DOM manipulation security
**Vulnerability:** XSS vulnerability via `innerHTML` usage in `showWinBanner`.
**Learning:** Even internal formatting logic can introduce XSS risks if user input (like names) is dynamically inserted into `innerHTML`.
**Prevention:** Use safe DOM manipulation like `document.createElement`, `textContent`, and `appendChild` instead of `innerHTML` for dynamically inserting user input.
