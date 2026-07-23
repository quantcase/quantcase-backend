https://mfdata.in/api/v1/schemes?limit=1000&has_holdings=true&exclude_fmp=true
https://mfdata.in/api/v1/schemes?limit=1000&has_holdings=true&exclude_fmp=true&offset=1000

Total 5821 schemes can be extracted using above endpoints



Other Available Endpoints:

/schemes/{amfi_code} → Full scheme details (NAV, AUM, category, family_id)
/schemes/{amfi_code}/nav/history → Historical NAV data
/schemes/{amfi_code}/nav/latest → Latest NAV
/schemes/{amfi_code}/returns → Returns (1Y, 3Y, etc.)
/schemes/{amfi_code}/ratios → Expense ratio & risk metrics
/schemes/{amfi_code}/info → Basic scheme info
/families/{family_id}/holdings → Portfolio holdings