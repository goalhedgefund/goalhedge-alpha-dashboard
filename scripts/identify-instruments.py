"""
Identify instrument IDs from a tick corpus against the Dhan scrip master.
Usage: python scripts/identify-instruments.py <gz-path> <scrip-master-csv>
"""
import sys
import gzip
import json
import zlib
import csv
import collections

def read_gz_tolerant(path):
    """Read a possibly corrupt/multi-member gzip file, skipping bad members."""
    with open(path, 'rb') as f:
        raw = f.read()

    instruments = collections.Counter()
    ltp_by_id = {}
    count = 0
    offset = 0

    while offset < len(raw):
        idx = raw.find(b'\x1f\x8b', offset)
        if idx == -1:
            break
        offset = idx
        d = zlib.decompressobj(wbits=47)
        try:
            decompressed = d.decompress(raw[offset:])
        except zlib.error:
            decompressed = d.flush()
        for line in decompressed.split(b'\n'):
            line = line.strip()
            if not line:
                continue
            try:
                tick = json.loads(line)
                iid = tick['instrumentId']
                instruments[iid] += 1
                ltp = tick.get('ltpPaise', 0)
                if ltp > 0:
                    if iid not in ltp_by_id:
                        ltp_by_id[iid] = []
                    ltp_by_id[iid].append(ltp)
                count += 1
            except Exception:
                pass
        # Advance past this gzip member
        consumed = len(raw[offset:]) - len(d.unconsumed_data if hasattr(d, 'unconsumed_data') and d.unconsumed_data else b'')
        offset += max(consumed, 2)

    return count, instruments, ltp_by_id


def load_scrip_lookup(csv_path):
    """Build a dict: securityId → row for fast lookup."""
    lookup = {}
    with open(csv_path, encoding='utf-8') as f:
        reader = csv.reader(f)
        next(reader, None)  # skip header
        for cols in reader:
            if len(cols) < 13:
                continue
            sec_id = cols[2].strip()
            lookup[sec_id] = {
                'tradingSymbol': cols[5].strip(),
                'expiryDate': cols[8].strip().split(' ')[0],
                'strikePaise': round(float(cols[9]) * 100) if cols[9].strip() else 0,
                'optionType': cols[10].strip(),
                'instrumentName': cols[3].strip(),
                'lotSize': int(float(cols[6])) if cols[6].strip() else 0,
            }
    return lookup


def main():
    gz_path = sys.argv[1] if len(sys.argv) > 1 else None
    scrip_path = sys.argv[2] if len(sys.argv) > 2 else r'D:\DHAN_LOGIN\api-scrip-master.csv'

    if gz_path is None:
        # Default: Jul 16 tick corpus
        gz_path = r'D:\Claude\workstation\services\scalper\data\dhan\ticks-s1-momentum-burst\2026-07-16\ticks.jsonl.gz'

    print(f'Reading: {gz_path}')
    count, instruments, ltp_by_id = read_gz_tolerant(gz_path)
    print(f'Total ticks parsed: {count}')
    print(f'Unique instruments: {len(instruments)}\n')

    print('Loading scrip master...')
    scrip = load_scrip_lookup(scrip_path)

    print('\n=== Instrument Summary ===')
    print(f'{"instrumentId":<20} {"ticks":>6}  {"ltp_min":>8} {"ltp_max":>8}  scrip info')
    print('-' * 100)
    for iid, tick_count in instruments.most_common():
        sec_id = iid.split(':', 1)[1] if ':' in iid else iid
        ltps = ltp_by_id.get(iid, [])
        ltp_min = min(ltps) / 100 if ltps else 0
        ltp_max = max(ltps) / 100 if ltps else 0
        row = scrip.get(sec_id)
        if row:
            info = f"{row['tradingSymbol']}  expiry={row['expiryDate']}  strike={row['strikePaise']/100:.0f}  {row['optionType']}  lot={row['lotSize']}"
        else:
            info = '(spot/index — not in FNO scrip master)'
        print(f'{iid:<20} {tick_count:>6}  {ltp_min:>8.2f} {ltp_max:>8.2f}  {info}')

    # Print OptionSpec array for pasting into replay script
    print('\n=== OptionSpec[] for replay ===')
    print('[')
    for iid, _ in instruments.most_common():
        sec_id = iid.split(':', 1)[1] if ':' in iid else iid
        row = scrip.get(sec_id)
        if row and row['optionType'] in ('CE', 'PE'):
            print(f"  {{ instrumentId: '{iid}' as InstrumentId, strikePaise: {row['strikePaise']}, right: '{row['optionType']}', expiry: '{row['expiryDate']}' }},")
    print(']')


if __name__ == '__main__':
    main()
