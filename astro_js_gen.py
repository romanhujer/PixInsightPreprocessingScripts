#!/usr/bin/env python3

###  NOT WORKING NOW !
####
import os

def generate_wbpp_xpsm(base_dir, output_file="run_me.xpsm"):
    lights, flats, darks, bias = [], [], [], []
    
    # Ignorujeme tyto složky úplně
    BLACK_LIST = ['DEBAYERED', 'CALIBRATED', 'REGISTERED', 'LOGS', 'MASTER_OUTPUT', 'ASIAIR', 'MYSCRIPT']
    
    # Cílová složka bude VŽDY v kořeni, kde pouštíte skript
    root_abs_path = os.path.abspath(base_dir).replace('\\', '/')
    target_dir = f"{root_abs_path}/master_output"
    
    for root, dirs, files in os.walk(base_dir):
        # Ošetření blacklistu
        root_upper = root.upper()
        if any(x in root_upper for x in BLACK_LIST):
            continue
            
        for file in files:
            if file.lower().endswith((".fits", ".fit", ".xisf")):
                path = os.path.abspath(os.path.join(root, file)).replace('\\', '/')
                f_up = file.upper()
                
                # Rozřazení
                if "FLAT" in f_up or "FLAT" in root_upper:
                    flats.append(path)
                elif "DARK" in f_up or "DARK" in root_upper:
                    darks.append(path)
                elif "BIAS" in f_up or "BIAS" in root_upper:
                    bias.append(path)
                else:
                    lights.append(path)

    def format_list(paths):
        return "".join([f'<item>{p}</item>' for p in paths])

    # XPSM struktura kompatibilní s PI 1.9.3
    xpsm_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<xpsm version="1.0" xmlns="http://www.pixinsight.com/xpsm" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
   <Icon id="WBPP_AUTOMAT" x="100" y="100" workspace="Workspace01">
      <Instance class="WeightedBatchPreprocessing" id="WBPP_INST" serializationVersion="2">
         <parameter id="outputDirectory">{target_dir}</parameter>
         <parameter id="lightFiles" childType="String" count="{len(lights)}">{format_list(lights)}</parameter>
         <parameter id="flatFiles" childType="String" count="{len(flats)}">{format_list(flats)}</parameter>
         <parameter id="darkFiles" childType="String" count="{len(darks)}">{format_list(darks)}</parameter>
         <parameter id="biasFiles" childType="String" count="{len(bias)}">{format_list(bias)}</parameter>
         <parameter id="exportCalibrationFiles">true</parameter>
         <parameter id="autoMode">true</parameter>
         <parameter id="isCFA">true</parameter>
         <parameter id="upToDate">false</parameter>
      </Instance>
   </Icon>
</xpsm>"""

    with open(output_file, "w", encoding="utf-8") as f:
        f.write(xpsm_content)
    
    print(f"✅ Vygenerováno: {output_file}")
    print(f"📍 Cílová složka: {target_dir}")
    print(f"📊 Načteno: {len(lights)} Lightů, {len(flats)} Flatů, {len(darks)} Darků.")

if __name__ == "__main__":
    generate_wbpp_xpsm(".")