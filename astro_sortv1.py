#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import shutil
import glob
import re
from datetime import datetime, timedelta

# --- KONFIGURACE KNIHOVNY ---
LIB_ROOT = os.path.abspath("!Master_Standard")

# Mapování na Mastery - Dwarf mastery se většinou dělají jinak, 
# ale složky pro ně vytvoříme.
CAMERA_MAP = {
    "2600MC": "ASI2600MC/G300_-10C",
    "2600MM": "ASI2600MM/G300_-10C",
    "1600MM": {"cold": "ASI1600MM/G0_-20C", "warm": "ASI1600MM/G139_-15C"},
    "294MC":  {"cold": "ASI294MC/G120_-20C", "warm": "ASI294MC/G120_0C"},
    "178MC":  "ASI178MC/G0_0C",
    "Dwarf3_Wide": None, # Dwarf většinou nemá Mastery v této struktuře
    "Dwarf3_Tele": None
}

# --- BARVY PRO KONZOLI ---
class Color:
    BLUE = '\033[94m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    BOLD = '\033[1m'
    END = '\033[0m'

def get_observation_night(filepath):
    """Určí noc (před 8:00 ráno patří k včerejšku)."""
    fname = os.path.basename(filepath)
    # Formát ASIAIR
    time_match = re.search(r'_(\d{8})-(\d{6})_', fname)
    if time_match:
        f_date = datetime.strptime(time_match.group(1), '%Y%m%d')
        f_time = datetime.strptime(time_match.group(2), '%H%M%S').time()
        if f_time.hour < 8:
            f_date = f_date - timedelta(days=1)
        return f_date.strftime('%m%d')
    
    # Fallback na čas modifikace (pro Dwarf)
    mtime = datetime.fromtimestamp(os.path.getmtime(filepath))
    if mtime.hour < 8:
        mtime = mtime - timedelta(days=1)
    return mtime.strftime('%m%d')

def get_info(filename):
    # Ignorujeme JPG
    if filename.lower().endswith('.jpg'): return None, None, None

    # Detekce objektu
    obj_match = re.search(r'(?:Light|Flat)_([^_]+)_', filename)
    obj = obj_match.group(1) if obj_match else "Unknown_Object"
    
    # Detekce kamery
    cam = None
    if "Dwarf3" in filename:
        cam = "Dwarf3_Tele" if "Tele" in filename else "Dwarf3_Wide"
    else:
        for k in CAMERA_MAP.keys():
            if k in filename:
                cam = k
                break
            
    # Detekce teploty
    temp_match = re.search(r'(-?\d+\.?\d*)C', filename)
    temp = float(temp_match.group(1)) if temp_match else None
    
    return obj, cam, temp

def get_master_path(cam, temp):
    cfg = CAMERA_MAP.get(cam)
    if isinstance(cfg, dict):
        if cam == "1600MM":
            return cfg["cold"] if temp and temp <= -19 else cfg["warm"]
        if cam == "294MC":
            return cfg["warm"] if temp and temp > -5 else cfg["cold"]
    return cfg

def process():
    print(f"{Color.BOLD}🚀 Startuji Astro Sorter (ASIAIR & Dwarf3)...{Color.END}")

    # 1. Smazání JPG
    for jpg in glob.glob("**/202[0-9]-*/**/*.jpg", recursive=True):
        try: os.remove(jpg)
        except: pass

    source_dirs = [d for d in os.listdir('.') if re.match(r'20\d{2}-\d{2}-\d{2}', d)]
    session_log = {}

    # --- FÁZE 1: LIGHTY ---
    for s_dir in source_dirs:
        all_files = []
        for ext in ('**/*.[fF][iI][tT]*', '**/*.xisf'):
            all_files.extend(glob.glob(os.path.join(s_dir, ext), recursive=True))

        for src in all_files:
            # IGNORUJEME AUTOSTACKY
            if "stack" in src.lower(): continue

            fname = os.path.basename(src)
            mmdd = get_observation_night(src)
            obj, cam, temp = get_info(fname)
            
            if not cam or not mmdd: continue

            if "Light_" in fname:
                # KONZOLOVÝ VÝSTUP
                print(f"{Color.BLUE}📦 [Noc {mmdd}]{Color.END} Objekt: {Color.BOLD}{obj}{Color.END} | Kamera: {Color.YELLOW}{cam}{Color.END}")

                dest_dir = os.path.join(obj, "Light", mmdd, f"ASI{cam}" if "Dwarf" not in cam else cam)
                os.makedirs(dest_dir, exist_ok=True)
                shutil.move(src, os.path.join(dest_dir, fname))

                key = (mmdd, cam)
                if key not in session_log: session_log[key] = set()
                session_log[key].add(obj)

                # LINKOVÁNÍ DARKŮ
                master_sub = get_master_path(cam, temp)
                if master_sub:
                    dark_dir = os.path.join(dest_dir, "Dark")
                    if not os.path.exists(dark_dir):
                        os.makedirs(dark_dir)
                        full_lib = os.path.join(LIB_ROOT, master_sub)
                        if os.path.exists(full_lib):
                            for m in os.listdir(full_lib):
                                os.symlink(os.path.join(full_lib, m), os.path.join(dark_dir, m))

    # --- FÁZE 2: FLATY ---
    for s_dir in source_dirs:
        flats = glob.glob(os.path.join(s_dir, "**/Flat_*.[fF][iI][tT]*"), recursive=True)
        for f_src in flats:
            if "stack" in f_src.lower(): continue
            fname = os.path.basename(f_src)
            mmdd = get_observation_night(f_src)
            _, cam, _ = get_info(fname)
            
            if (mmdd, cam) in session_log:
                print(f"{Color.GREEN}✨ [Flat]{Color.END} Pro noc {mmdd} a kameru {cam}")
                for target_obj in session_log[(mmdd, cam)]:
                    f_dest = os.path.join(target_obj, "Light", mmdd, f"ASI{cam}" if "Dwarf" not in cam else cam, "Flat")
                    os.makedirs(f_dest, exist_ok=True)
                    shutil.copy2(f_src, os.path.join(f_dest, fname))
            os.remove(f_src)

    # 3. ÚKLID
    print(f"{Color.YELLOW}🧹 Čistím prázdné složky...{Color.END}")
    for s_dir in source_dirs:
        for root, dirs, _ in os.walk(s_dir, topdown=False):
            for d in dirs:
                p = os.path.join(root, d)
                try:
                    if not os.listdir(p): os.rmdir(p)
                except: pass
        if os.path.exists(s_dir) and not os.listdir(s_dir): os.rmdir(s_dir)

    print(f"{Color.GREEN}{Color.BOLD}✅ HOTOVO! Všechno je na svém místě.{Color.END}")

if __name__ == "__main__":
    process()