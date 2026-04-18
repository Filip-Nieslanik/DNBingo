// ============================================================
// POSTUP: Jak získat webovou konfiguraci Firebase
// ------------------------------------------------------------
// 1. Přejdi na https://console.firebase.google.com/
// 2. Otevři projekt "dnbingo-1eceb"
// 3. Klikni na ikonu ozubeného kola → "Nastavení projektu"
// 4. Sjeď dolů na sekci "Vaše aplikace"
//    → Pokud tam ještě není webová aplikace (</>), klikni na
//      tu ikonu a přidej ji (název např. "bingo-web")
// 5. Zkopíruj hodnoty níže z vygenerovaného firebaseConfig
// 6. V Firebase konzoli jdi na Firestore Database → Vytvořit
//    → Začít v testovacím režimu (30 dní, stačí na start)
// ============================================================

const firebaseConfig = {
  apiKey:            "DOPLŇ_ZDE",           // z Firebase konzole
  authDomain:        "dnbingo-1eceb.firebaseapp.com",
  projectId:         "dnbingo-1eceb",
  storageBucket:     "dnbingo-1eceb.appspot.com",
  messagingSenderId: "DOPLŇ_ZDE",
  appId:             "DOPLŇ_ZDE"
};

firebase.initializeApp(firebaseConfig);
