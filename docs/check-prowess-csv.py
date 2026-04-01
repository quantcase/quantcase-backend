python3 -c "
import csv
with open('lib/osc_mod_qtr_v1.csv', encoding='utf-8-sig') as f:
    rows = list(csv.reader(f))
print('Total rows:', len(rows))
print('Total cols in row 0:', len(rows[0]))
print('Total cols in row 5 (header):', len(rows[5]))
print()
print('Row 0 (source) first 5 cols:', rows[0][:5])
print('Row 4 (quarter labels) first 25 cols:', rows[4][:25])
print('Row 5 (col headers) first 22 cols:', rows[5][:22])
print()
print('Unique quarters in row 4:', list(dict.fromkeys([c for c in rows[4] if c])))
print('Indicators per period (row 5, cols 1-21):', rows[5][1:21])
print()
print('First data row (row 6), cols 0 and 1:', rows[6][0], '|', rows[6][1])
"
