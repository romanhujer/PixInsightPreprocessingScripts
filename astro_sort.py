#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import shutil
import re
import pathlib
from datetime import datetime, timedelta

# --- KONFIGURACE KNIHOVNY ---
LIB_ROOT = os.path.abspath("!Master_Standard")

CAMERA_MAP = {
    "2600MC": "ASI2600MC/G300_-10C",
    "2600MM": "ASI2600MM/G300_-10C",
    "1600MM": {"cold": "ASI1600MM/G0_-20C", "warm": "ASI1600MM/G139_-15C"},
    "294MC":  {"cold": "ASI294MC/G120_-20C", "warm": "ASI294MC/G120_0C"},
    "178MC":  "ASI178MC/G0_0C",
    "Dwarf3_Wide": None,
    "Dwarf3_Tele": None
}

class Color:
    BLUE = '\033[94m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    BOLD = '\033[1m'
    END = '\033[0m'

def get_observation_night(path_obj):
    """Určí noc (před 8:00 ráno patří k včerejšku) z názvu souboru ASIAIR."""
    fname = path_obj.name
    # Hledá formát 20241022-193022
    time_match = re.search(r'_(\d{8})-(\d{6})_', fname)
    if time_match:
        f_date = datetime.strptime(time_match.group(1), '%Y%m%d')
        f_time = datetime.strptime(time_match.group(2), '%H%M%S').time()
        if f_time.hour < 8:
            f_date = f_date - timedelta(days=1)
        return f_date.strftime('%m%d')
    
    # Pokud v názvu není datum, zkusíme čas souboru
    mtime = datetime.fromtimestamp(path_obj.stat().st_mtime)
    if mtime.hour < 8:
        mtime = mtime - timedelta(days=1)
    return mtime.strftime('%m%d')

def get_info(filename):
    if filename.lower().endswith(('.jpg', '.jpeg')): return None, None, None
    
    # Detekce objektu - v ASIAIR názvech bývá za typem (Light_M31_...)
    obj_match = re.search(r'(?:Light|Flat|Dark|Bias)_([^_]+)_', filename)
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
    print(f"{Color.BOLD}🚀 Startuji Astro Sorter (ASIAIR Crawler Mode)...{Color.END}")
    
    session_log = {} 
    source_root = pathlib.Path("./ASIAIR/")
    dest_root = pathlib.Path(".")
    all_files = list(source_root.rglob('*'))
    
    processed_count = 0

    # --- FÁZE 1: LIGHTY A MAZÁNÍ SMETÍ ---
    for path in all_files:
        # Přeskočit složky, mastery a skript samotný
        if path.is_dir() or "!Master_Standard" in path.parts or "myScript" in path.parts:
            continue

        # 1. Smazání JPG
        if path.suffix.lower() in ['.jpg', '.jpeg']:
            print(f"🗑️ Mažu náhled: {path.name}")
            path.unlink()
            continue

        # 2. Zpracování FIT/XISF
        if path.suffix.lower() in ['.fit', '.fits', '.xisf']:
            if "stack" in path.name.lower(): continue
            
            fname = path.name
            mmdd = get_observation_night(path)
            obj, cam, temp = get_info(fname)

            if not cam or not mmdd: continue

            # Třídíme jen Lighty (Flaty až v druhé fázi)
            if "Light_" in fname:
                print(f"{Color.BLUE}📦 [Noc {mmdd}]{Color.END} Objekt: {Color.BOLD}{obj}{Color.END} | {cam}")
                
                cam_dirname = f"ASI{cam}" if "Dwarf" not in cam else cam
                dest_dir = dest_root / obj / "Light" / mmdd / cam_dirname
                dest_dir.mkdir(parents=True, exist_ok=True)
                
                shutil.move(str(path), str(dest_dir / fname))
                processed_count += 1

                key = (mmdd, cam)
                if key not in session_log: session_log[key] = set()
                session_log[key].add(obj)

                # Symlink na Darky
                master_sub = get_master_path(cam, temp)
                if master_sub:
                    dark_dir = dest_dir / "Dark"
                    if not dark_dir.exists():
                        dark_dir.mkdir(parents=True, exist_ok=True)
                        full_lib = pathlib.Path(LIB_ROOT) / master_sub
                        if full_lib.exists():
                            for m in full_lib.iterdir():
                                try:
                                    # Relativní symlink je lepší pro přenositelnost
                                    target = os.path.relpath(str(m), str(dark_dir))
                                    os.symlink(target, str(dark_dir / m.name))
                                except FileExistsError: pass

    # --- FÁZE 2: FLATY (hledáme znovu, protože se mohly pohnout nebo zůstat) ---
    for path in list(source_root.rglob('Flat_*')):
        if path.suffix.lower() not in ['.fit', '.fits', '.xisf']: continue
        
        mmdd = get_observation_night(path)
        _, cam, _ = get_info(path.name)
        
        if (mmdd, cam) in session_log:
            print(f"{Color.GREEN}✨ [Flat]{Color.END} Rozesílám pro noc {mmdd} ({cam})")
            for target_obj in session_log[(mmdd, cam)]:
                cam_dirname = f"ASI{cam}" if "Dwarf" not in cam else cam
                f_dest = dest_root / target_obj / "Light" / mmdd / cam_dirname / "Flat"
                f_dest.mkdir(parents=True, exist_ok=True)
                shutil.copy2(str(path), str(f_dest / path.name))
        
        path.unlink() # Smazat původní Flat

    # --- FÁZE 3: ÚKLID ASIAIR SLOŽEK ---
    print(f"{Color.YELLOW}🧹 Čistím prázdné ASIAIR složky...{Color.END}")
    for folder in ["ASIAIR", "Autorun", "Plan", "Live"]:
        p = source_root / folder
        if p.exists():
            # Smaže složku jen pokud je prázdná (včetně podadresářů)
            for root, dirs, files in os.walk(str(p), topdown=False):
                for d in dirs:
                    try: os.rmdir(os.path.join(root, d))
                    except: pass
            try: os.rmdir(str(p))
            except: pass

    if processed_count == 0:
        print(f"{Color.RED}Nebyla nalezena žádná nová data k roztřídění.{Color.END}")
    else:
        print(f"{Color.GREEN}{Color.BOLD}✅ HOTOVO! Roztříděno {processed_count} souborů.{Color.END}")

if __name__ == "__main__":
    process()