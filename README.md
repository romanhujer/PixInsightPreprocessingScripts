## PixInsight Preprocess Scripts

[![Language: CZ](https://img.shields.io/badge/lang-cz-red.svg)](README.md)
[![Language: EN](https://img.shields.io/badge/lang-en-blue.svg)](README.md)

---

## 🇨🇿 ČEŠTINA

Sada Python skriptů pro automatizaci přípravy astrofotografií. Tento nástroj řeší "špinavou práci" spojenou s tříděním souborů z **ASIAIR** a **Dwarf3**, aby byla data okamžitě připravena pro **PixInsight WBPP (Weighted Batch PreProcessing)**.

### 🌟 Hlavní funkce
* **Chytré třídění:** Rozřadí soubory do složek podle názvu objektu nalezeného v metadatech/názvu.
* **Logika astronomické noci:** Snímky pořízené mezi půlnocí a 8:00 ráno automaticky přiřadí k předchozímu kalendářnímu dni (vytvoří složku `MMDD`).
* **Automatické Darky & Biasy:** Na základě modelu kamery a zjištěné teploty vytvoří symbolické odkazy (symlinks) na správné mastery z vaší knihovny `!Master_Standard`.
* **Podpora Dwarf3:** Rozlišuje mezi `Wide` a `Tele` objektivem a vytváří odpovídající strukturu.
* **Čištění:** Automaticky odstraňuje nepotřebné `.jpg` náhledy a po úspěšném přesunu smaže prázdné zdrojové složky, čímž udržuje disk uklizený.

### 🛠️ Použití
1.  Ujistěte se, že máte v kořenovém adresáři složku `!Master_Standard` se svými mastery.
2.  Zkopírujte zdrojové složky s datem (např. `2026-04-12`) do pracovního adresáře.
3.  Spusťte skript:
    ```bash
    python3 astro_sort.py
    ```

---

## 🇺🇸 ENGLISH

A collection of Python scripts for automated astrophotography data organization. This tool handles the "heavy lifting" of sorting files from **ASIAIR** and **Dwarf3**, making them instantly ready for **PixInsight WBPP (Weighted Batch PreProcessing)**.

### 🌟 Key Features
* **Smart Sorting:** Organizes files into folders based on the object name found in the filename/metadata.
* **Observation Night Logic:** Images captured between midnight and 8:00 AM are automatically grouped with the previous calendar day (creating an `MMDD` folder).
* **Automatic Darks & Biases:** Based on the camera model and detected temperature, it creates symbolic links (symlinks) to the correct masters from your `!Master_Standard` library.
* **Dwarf3 Support:** Distinguishes between `Wide` and `Tele` lenses and creates the appropriate folder structure.
* **Cleanup:** Automatically deletes unnecessary `.jpg` previews and removes empty source directories after a successful move, keeping your storage clean.

### 🛠️ Usage
1.  Ensure you have the `!Master_Standard` folder with your master frames in the root directory.
2.  Copy your source date folders (e.g., `2026-04-12`) into the working directory.
3.  Run the script:
    ```bash
    python3 astro_sort.py
    ```

---

## 📁 Target Structure / Cílová struktura
```text
Object_Name/
└── Light/
    └── MMDD (Date)/
        └── ASI_Camera_Model/
            ├── Light_Files...
            ├── Flat/ (Copied/Rozkopírované)
            └── Dark/ (Symlinks to !Master_Standard)


---

## ⚖️ License & Disclaimer / Licence a záruka

**[CZ] Varování:** Tento skript provádí přesuny a mazání souborů. Autor nenese žádnou odpovědnost za případnou ztrátu nebo poškození dat způsobené používáním tohoto softwaru. Používejte na vlastní nebezpečí a vždy mějte data zálohovaná.
Licencováno pod **GNU GPLv3**.

**[EN] Disclaimer:** This script performs file moves and deletions. The author assumes no responsibility for any data loss or damage caused by using this software. Use at your own risk and always keep your data backed up.
Licensed under **GNU GPLv3**.            

VERSION="1.0.1"
