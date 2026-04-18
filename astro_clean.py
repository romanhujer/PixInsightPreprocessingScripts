#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import shutil
import glob
import re
from datetime import datetime, timedelta

VERSION="1.0.2"
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

def get_observation_night(filepath):
    fname = os.path.basename(filepath)
    time_match = re.search(r'(\d{8})-(\d{6})', fname)
    if time_match:
        f_date = datetime.strptime(time_match.group(1), '%Y%m%d')
        f_time = datetime.strptime(time_match.group(2), '%H%M%S').time()
        if f_time.hour < 8:
            f_date = f_date - timedelta(days=1)
        return f_date.strftime('%m%d')
    return datetime.fromtimestamp(os.path.getmtime(filepath)).strftime('%m%d')

def get_info(filename):
    if filename.lower().endswith('.jpg'): return None, None, None
    parts = filename.split('_')
    obj = "Unknown_Object"
    if "Light" in parts or "Flat" in parts:
        try:
            start_idx = 1
            # Hledáme prvek, který obsahuje informaci o expozici (např. 30.0s)
            end_idx = next(i for i, s in enumerate(parts) if 's' in s and any(c.isdigit() for c in s))
            obj = "_".join(parts[start_idx:end_idx])
        except: pass
    cam = next((k for k in CAMERA_MAP.keys() if k in filename), None)
    temp_match = re.search(r'(-?\d+\.?\d*)C', filename)
    temp = float(temp_match.group(1)) if temp_match else None
    return obj, cam, temp

def get_master_path(cam, temp):
    cfg = CAMERA_MAP.get(cam)
    if isinstance(cfg, dict):
        if cam == "1600MM": return cfg["cold"] if temp and temp <= -19 else cfg["warm"]
        if cam == "294MC": return cfg["warm"] if temp and temp > -5 else cfg["cold"]
    return cfg

def process():
    print(f"{Color.BOLD}🚀 Startuji Astro Sorter...{Color.END}")

    # --- ZMĚNA ZDE: Najdeme složky s datem kdekoli (v ASIAIR i jinde) ---
    all_dirs = []
    for root, dirs, files in os.walk('.'):
        for d in dirs:
            if re.match(r'20\d{2}-\d{2}-\d{2}', d):
                all_dirs.append(os.path.join(root, d))
    
    # Odstraníme duplikáty a TAR archivy z cesty
    source_dirs = [d for d in list(set(all_dirs)) if ".tar" not in d]

    if not source_dirs:
        print(f"{Color.RED}❌ Žádná data k roztřídění nenalezena!{Color.END}")
        return

    session_log = {}

    # --- FÁZE 1: LIGHTY ---
    for s_dir in source_dirs:
        print(f"{Color.YELLOW}🔍 Prohledávám: {s_dir}{Color.END}")
        files = []
        for ext in ('**/*.fit', '**/*.fits', '**/*.xisf', '**/*.jpg'):
            files.extend(glob.glob(os.path.join(s_dir, ext), recursive=True))

        for src in files:
            if "stack" in src.lower(): continue
            fname = os.path.basename(src)
            
            # Smazání JPG
            if fname.lower().endswith('.jpg'):
                try: os.remove(src)
                except: pass
                continue

            obj, cam, temp = get_info(fname)
            mmdd = get_observation_night(src)
            
            if not cam or not mmdd: continue

            if "Light" in fname:
                print(f"{Color.BLUE}📦 [Noc {mmdd}]{Color.END} Obj: {Color.BOLD}{obj}{Color.END} | Cam: {Color.YELLOW}{cam}{Color.END}")
                dest_dir = os.path.join(obj, "Light", mmdd, f"ASI{cam}" if "Dwarf" not in cam else cam)
                os.makedirs(dest_dir, exist_ok=True)
                shutil.move(src, os.path.join(dest_dir, fname))
                
                key = (mmdd, cam)
                if key not in session_log: session_log[key] = set()
                session_log[key].add(obj)

                # DARK LINK
                master_sub = get_master_path(cam, temp)
                if master_sub:
                    dark_target = os.path.join(dest_dir, "Dark")
                    if not os.path.exists(dark_target):
                        os.makedirs(dark_target)
                        full_lib = os.path.join(LIB_ROOT, master_sub)
                        if os.path.exists(full_lib):
                            for m in os.listdir(full_lib):
                                try: os.symlink(os.path.join(full_lib, m), os.path.join(dark_target, m))
                                except: pass

    # --- FÁZE 2: FLATY ---
    for s_dir in source_dirs:
        flats = glob.glob(os.path.join(s_dir, "**/Flat_*.[fF][iI][tT]*"), recursive=True)
        for f_src in flats:
            fname = os.path.basename(f_src)
            mmdd = get_observation_night(f_src)
            _, cam, _ = get_info(fname)
            if (mmdd, cam) in session_log:
                for target_obj in session_log[(mmdd, cam)]:
                    f_dest = os.path.join(target_obj, "Light", mmdd, f"ASI{cam}" if "Dwarf" not in cam else cam, "Flat")
                    os.makedirs(f_dest, exist_ok=True)
                    shutil.copy2(f_src, os.path.join(f_dest, fname))
            try: os.remove(f_src)
            except: pass

    print(f"{Color.GREEN}{Color.BOLD}✅ HOTOVO!{Color.END}")

if __name__ == "__main__":
    process()