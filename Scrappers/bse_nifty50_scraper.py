"""
BSE Corporate Announcements Scraper — Nifty50
==============================================
Fetches Investor Presentations and Earnings Call Transcripts for Nifty50
companies from the BSE public API and writes results to a CSV.

Usage:
    python3 bse_nifty50_scraper.py

Output:
    ~/Desktop/bse_nifty50_3yr.csv  (columns: scrip, company, type, date, headline, url)

TOKEN / AUTH NOTES:
    The BSE announcements API (api.bseindia.com) is publicly accessible —
    no login, API key, or session token is required as of June 2026.

    Headers that look "token-like" but are NOT dynamic:
      - origin / referer    : always "https://www.bseindia.com", static
      - sec-ch-ua           : Chrome client hints tied to browser version;
                              BSE does not validate these server-side
      - user-agent          : standard browser UA, static string is fine

    If you ever start getting 401 / 403 / empty Table responses, BSE may
    have added authentication. In that case:
      1. Open https://www.bseindia.com in Chrome DevTools → Network tab
      2. Filter by "AnnSubCategoryGetData"
      3. Copy the request headers — look for a new Cookie or Authorization header
      4. Add it to the HEADERS dict below and refresh periodically (cookies
         typically expire within a browser session, ~30 min to a few hours)
"""

import urllib.request
import json
import time
import csv
from datetime import datetime, timedelta

# ---------------------------------------------------------------------------
# Request headers — mimic a real Chrome browser to avoid bot detection.
# All values here are static; none require periodic regeneration.
# ---------------------------------------------------------------------------
HEADERS = {
    "accept": "application/json, text/plain, */*",
    "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
    "origin": "https://www.bseindia.com",
    "referer": "https://www.bseindia.com/",
    "user-agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/147.0.0.0 Safari/537.36"
    ),
}

# ---------------------------------------------------------------------------
# Nifty50 companies: BSE scrip code -> company name
# BSE scrip codes are permanent identifiers assigned at listing and never change.
# Source: BSE website stock lookup / NSE Nifty50 constituent list.
# ---------------------------------------------------------------------------
NIFTY50 = {
    500325: "Reliance",       532540: "TCS",             500180: "HDFC Bank",
    500209: "Infosys",        532174: "ICICI Bank",      500696: "HUL",
    500875: "ITC",            500112: "SBI",              532454: "Airtel",
    500247: "Kotak",          532215: "Axis Bank",        500510: "L&T",
    500820: "Asian Paints",   532500: "Maruti",           524715: "Sun Pharma",
    500114: "Titan",          500034: "Bajaj Finance",    532281: "HCL Tech",
    507685: "Wipro",          532538: "UltraTech",        532898: "Power Grid",
    532555: "NTPC",           500790: "Nestle",           532755: "Tech Mahindra",
    532921: "Adani Ports",    532978: "Bajaj Finserv",    500228: "JSW Steel",
    500570: "Tata Motors",    500520: "M&M",              500470: "Tata Steel",
    500124: "Dr Reddys",      500087: "Cipla",            532488: "Divis Labs",
    505200: "Eicher Motors",  533278: "Coal India",       500182: "Hero MotoCorp",
    500300: "Grasim",         532187: "IndusInd Bank",    500440: "Hindalco",
    500312: "ONGC",           540719: "SBI Life",         508869: "Apollo Hospitals",
    500547: "BPCL",           500800: "Tata Consumer",    540005: "LTIMindtree",
    512599: "Adani Ent",      532977: "Bajaj Auto",       540777: "HDFC Life",
    532286: "Jindal Steel",   543498: "MSUMI",
}

# ---------------------------------------------------------------------------
# Only these two subcategories are relevant; all other announcement types
# (board meetings, dividends, regulatory filings, etc.) are filtered out.
# ---------------------------------------------------------------------------
TARGET_SUBCATS = {"Investor Presentation", "Earnings Call Transcript", "Analyst / Investor Meet"}

# ---------------------------------------------------------------------------
# Date range: how far back to fetch announcements.
# Change LOOKBACK_DAYS to cover a different window.
# ---------------------------------------------------------------------------
LOOKBACK_DAYS = 365 * 3   # 3 years

# ---------------------------------------------------------------------------
# Rate limiting: sleep between page fetches and between companies.
# Keeps BSE from returning 429 / empty responses under load.
# ---------------------------------------------------------------------------
SLEEP_BETWEEN_PAGES = 0.3   # seconds
SLEEP_BETWEEN_STOCKS = 0.5  # seconds

# Base URL for downloading the actual PDF attachment.
# ATTACHMENTNAME from the API is a UUID filename (e.g. "abc123.pdf").
ATTACHMENT_BASE_URL = "https://www.bseindia.com/xml-data/corpfiling/AttachHis/"


def fetch_page(scrip: int, page: int, from_date: str, to_date: str) -> dict:
    """
    Fetch one page of announcements for a given BSE scrip code.

    API returns 50 rows per page. Use Table1[0].ROWCNT to determine
    total rows and calculate how many pages to fetch.

    Args:
        scrip     : BSE scrip code (e.g. 500325 for Reliance)
        page      : 1-indexed page number
        from_date : start date in YYYYMMDD format
        to_date   : end date in YYYYMMDD format

    Returns:
        Parsed JSON dict with keys "Table" (rows) and "Table1" (pagination).
    """
    url = (
        "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w"
        f"?pageno={page}"
        f"&strCat=-1"           # -1 = all categories
        f"&strPrevDate={from_date}"
        f"&strScrip={scrip}"
        f"&strSearch=P"         # P = filings with attachments
        f"&strToDate={to_date}"
        f"&strType=C"           # C = company announcements
        f"&subcategory=-1"      # -1 = all subcategories (we filter client-side)
    )
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.loads(response.read())


def get_docs(scrip: int, name: str, from_date: str, to_date: str) -> list[dict]:
    """
    Fetch ALL pages for a scrip and return only the rows matching TARGET_SUBCATS.

    Pagination: the API returns Table1[0].ROWCNT as the total row count.
    We walk pages until page * 50 >= total.
    """
    results = []
    page = 1

    while True:
        data = fetch_page(scrip, page, from_date, to_date)
        rows = data.get("Table", [])
        total = (data.get("Table1") or [{}])[0].get("ROWCNT", 0)

        for row in rows:
            if row.get("SUBCATNAME") in TARGET_SUBCATS and row.get("ATTACHMENTNAME"):
                results.append({
                    "scrip":    scrip,
                    "company":  name,
                    "type":     row["SUBCATNAME"],
                    "headline": row.get("HEADLINE", ""),
                    "date":     row.get("NEWS_DT", "")[:10],
                    # Full direct URL to download the PDF
                    "url":      ATTACHMENT_BASE_URL + row["ATTACHMENTNAME"],
                })

        # Stop when we've consumed all pages
        if page * 50 >= total:
            break

        page += 1
        time.sleep(SLEEP_BETWEEN_PAGES)

    return results


def main():
    to_date   = datetime.today().strftime("%Y%m%d")
    from_date = (datetime.today() - timedelta(days=LOOKBACK_DAYS)).strftime("%Y%m%d")
    print(f"Date range: {from_date} -> {to_date}\n")

    all_docs = []

    for i, (scrip, name) in enumerate(NIFTY50.items(), 1):
        print(f"[{i}/{len(NIFTY50)}] {name} ({scrip})...", end=" ", flush=True)
        try:
            docs = get_docs(scrip, name, from_date, to_date)
            print(f"{len(docs)} docs")
            all_docs.extend(docs)
        except Exception as e:
            print(f"ERROR: {e}")
        time.sleep(SLEEP_BETWEEN_STOCKS)

    out_path = "/Users/palash/Desktop/bse_nifty50_3yr.csv"
    with open(out_path, "w", newline="") as f:
        writer = csv.DictWriter(
            f, fieldnames=["scrip", "company", "type", "date", "headline", "url"]
        )
        writer.writeheader()
        writer.writerows(all_docs)

    print(f"\nDone. {len(all_docs)} docs -> {out_path}")


if __name__ == "__main__":
    main()
