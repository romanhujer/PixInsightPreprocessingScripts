#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import shutil
import re

SOURCE_LIB = "../!Master"
TARGET_LIB = "../!Master_Standard"

def get_param(text, pattern, default="0"):
    match = re.search(pattern, text, re.IGNORECASE)
    return match.group(1) if match else default

def standardize_masters():
    if os.path.exists(TARGET_LIB):
        shutil.rmtree(TARGET_LIB)
    os.makedirs(TARGET_LIB)

    print("--- Startuji standardizaci knihovny (Struktura pro WBPP) ---")

    for root, dirs, files in os.walk(SOURCE_LIB):
        files = [f for f in files if not f.startswith('.')]
        
        for f in files:
            if not f.lower().endswith(('.xisf', '.fit', '.fits')):
                continue
            
            path_upper = root.upper()
            file_upper = f.upper()

            # 1. Identifikace kamery
            camera = "Unknown"
            if "2600MC" in path_upper: camera = "ASI2600MC"
            elif "2600MM" in path_upper: camera = "ASI2600MM"
            elif "1600MM" in path_upper: camera = "ASI1600MM"
            elif "294MC" in path_upper: camera = "ASI294MC"
            elif "DWARF3" in path_upper: camera = "Dwarf3"
            elif "178MC" in path_upper: camera = "ASI178MC"
            
            if camera == "Unknown": continue

            # 2. Gain a Teplota
            gain_val = get_param(path_upper, r'G(\d+)', "0")
            temp_val = get_param(path_upper, r'([-]?\d+)C', "0")
            
            # 3. Typ, Expozice, Binning
            m_type = "Dark"
            if "BIAS" in file_upper or "BIAS" in path_upper: m_type = "Bias"
            if "FLAT" in file_upper or "FLAT" in path_upper: m_type = "Flat"

            exp_val = get_param(f, r'(?:EXPOSURE-|EXPTIME_|E|EXPTIME-)([0-9.]+)', "X")
            if exp_val == "X": exp_val = get_param(f, r'(\d+\.?\d*)S', "0")
            if exp_val != "X":
                exp_val = exp_val.rstrip('0').rstrip('.') if '.' in exp_val else exp_val

            bin_val = get_param(file_upper, r'BIN[NING]*[-_ ]?(\d)', "1")

            # --- ZMĚNA ZDE: STRUKTURA SLOŽEK ---
            # Vytvoříme složku např.: !Master_Standard/ASI2600MC/G300_-10C/
            session_folder = f"G{gain_val}_{temp_val}C"
            dest_dir = os.path.join(TARGET_LIB, camera, session_folder)
            
            if not os.path.exists(dest_dir):
                os.makedirs(dest_dir)

            new_name = f"Master_{m_type}_{camera}_G{gain_val}_T{temp_val}_E{exp_val}s_B{bin_val}.xisf"
            
            try:
                shutil.copy2(os.path.join(root, f), os.path.join(dest_dir, new_name))
                print(f"OK: {camera}/{session_folder} -> {new_name}")
            except Exception as e:
                print(f"Chyba: {e}")

    print(f"\nHotovo. Nyní máte Mastery rozdělené tak, aby se WBPP nespletlo.")

if __name__ == "__main__":
    standardize_masters()