#!/usr/bin/env python3
# -*- coding: utf-8 -*-

###  NOT WORKING NOW !
####


import os

def generate_pi_script(base_dir, output_js):
    IGNORE_DIRS = ['ASIAIR', 'myScript', 'master_output']
    bpp_dir = "/Applications/PixInsight/src/scripts/BatchPreprocessing"

    # HLAVIČKA: Agresivní hledání objektu v paměti
    js_content = f"""#include "{bpp_dir}/WBPP.js"

var engine;

// Zkusíme najít instanci v globálním prostoru
if (typeof WeightedBatchPreprocessingEngine !== 'undefined') {{
    engine = new WeightedBatchPreprocessingEngine();
}} else if (typeof BatchPreprocessingEngine !== 'undefined') {{
    engine = new BatchPreprocessingEngine();
}} else if (typeof WeightedBatchPreprocessing !== 'undefined') {{
    engine = WeightedBatchPreprocessing;
}}

if (!engine) {{
    console.writeln("❌ Stále nenalezeno. Zkouším poslední záchranu...");
    engine = new WBPPEngine(); // Některé beta verze 1.9.3 používají toto
}}

if (engine) {{
    console.writeln("✅ Engine nalezen!");
    engine.exportCalibrationFiles = true;
"""

    found_total = 0
    first_target_set = False

    for item in os.listdir(base_dir):
        obj_path = os.path.join(base_dir, item)
        if not os.path.isdir(obj_path) or item.startswith('.') or item in IGNORE_DIRS:
            continue

        for root, dirs, files in os.walk(obj_path, followlinks=True):
            for file in files:
                if file.lower().endswith((".fits", ".fit", ".xisf")):
                    full_path = os.path.abspath(os.path.join(root, file)).replace('\\', '/')
                    f_upper = file.upper()
                    r_upper = root.upper()

                    # Definice typů (pokud by FileKind nebyl načten)
                    kind = "0"; # Light
                    if "/FLAT/" in r_upper or "FLAT" in f_upper: kind = "1"
                    elif "DARK" in r_upper or "DARK" in f_upper: kind = "2"
                    elif "BIAS" in r_upper or "BIAS" in f_upper: kind = "3"
                    elif "/LIGHT/" in r_upper: kind = "0"
                    else: continue

                    filter_name = ""
                    for f_tag in ["_L_", "_R_", "_G_", "_B_", "_HA_", "_OIII_", "_SII_"]:
                        if f_tag in f_upper or f"/{f_tag.strip('_')}/" in r_upper:
                            filter_name = f_tag.strip('_')
                            break

                    objekt = item
                    kamera = "Unknown_Cam"
                    noc = "Unknown_Date"
                    path_parts = full_path.split('/')
                    for p in path_parts:
                        if "ASI" in p: kamera = p
                        if p.isdigit() and len(p) == 4: noc = p
                    if "MASTER" in f_upper: noc = "MASTER"

                    if not first_target_set and ("NGC" in objekt or "M" in objekt):
                        target_dir = os.path.join(os.path.abspath(obj_path), "master_output").replace('\\', '/')
                        js_content += f'    engine.targetDirectory = "{target_dir}";\n'
                        first_target_set = True

                    # Přímé použití čísel pro Kind pro jistotu
                    js_content += f'    engine.addFile({kind}, "{full_path}", "{filter_name}", 1, 0, "{objekt}", "{noc}", "{kamera}");\n'
                    found_total += 1

    js_content += """
    engine.update();
    engine.showWindow();
} else {
    console.writeln("❌ Fatal: PixInsight 1.9.3 zcela změnil API. Musíme použít jinou metodu.");
}
"""
    
    with open(output_js, "w", encoding="utf-8") as f:
        f.write(js_content)
    
    print(f"✅ Vygenerováno: {output_js} ({found_total} souborů)")

if __name__ == "__main__":
    generate_pi_script(".", "run_wbpp.js")