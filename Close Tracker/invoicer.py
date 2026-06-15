import os
import re
import pandas as pd
from pathlib import Path

CSV_PATH = Path(__file__).parent / "EPiC Capstone - Revenue - By Client & Project(Revenue by Client and Project).csv"
OUTPUT_DIR = Path(__file__).parent / "invoices"

MONTH_ORDER = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


def parse_currency(value: str) -> float:
    return float(re.sub(r"[$,]", "", str(value).strip()))


def load_data() -> pd.DataFrame:
    df = pd.read_csv(CSV_PATH, encoding="cp1252")
    df.columns = ["client", "project", "month", "revenue"]
    df["revenue"] = df["revenue"].apply(parse_currency)
    df["month"] = df["month"].str.strip()
    df["client"] = df["client"].str.strip()
    return df


def aggregate(df: pd.DataFrame) -> pd.DataFrame:
    return (
        df.groupby(["client", "month", "project"], as_index=False)["revenue"]
        .sum()
        .sort_values(
            ["client", "month", "project"],
            key=lambda col: col.map(MONTH_ORDER.index) if col.name == "month" else col,
        )
    )


def render_invoice(client: str, month: str, line_items: pd.DataFrame) -> str:
    total = line_items["revenue"].sum()
    rows = "\n".join(
        f"<tr><td>{row['project']}</td><td>${row['revenue']:,.2f}</td></tr>"
        for _, row in line_items.iterrows()
    )
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Invoice – {client} – {month}</title>
  <style>
    body {{ font-family: Arial, sans-serif; max-width: 720px; margin: 48px auto; color: #111; }}
    h1 {{ font-size: 1.6rem; margin-bottom: 4px; }}
    .meta {{ color: #555; margin-bottom: 32px; }}
    table {{ width: 100%; border-collapse: collapse; }}
    th {{ text-align: left; border-bottom: 2px solid #111; padding: 8px 4px; }}
    td {{ padding: 8px 4px; border-bottom: 1px solid #ddd; }}
    td:last-child, th:last-child {{ text-align: right; }}
    .total-row td {{ font-weight: bold; border-top: 2px solid #111; border-bottom: none; }}
  </style>
</head>
<body>
  <h1>Pioneer Management Consulting</h1>
  <div class="meta">Invoice · {client} · {month} 2026</div>
  <table>
    <thead><tr><th>Project</th><th>Amount</th></tr></thead>
    <tbody>
      {rows}
      <tr class="total-row"><td>Total</td><td>${total:,.2f}</td></tr>
    </tbody>
  </table>
</body>
</html>"""


def generate_invoices():
    OUTPUT_DIR.mkdir(exist_ok=True)
    df = load_data()
    agg = aggregate(df)

    count = 0
    for (client, month), group in agg.groupby(["client", "month"]):
        safe_client = re.sub(r'[\\/*?:"<>|]', "_", client)
        filename = OUTPUT_DIR / f"{safe_client} - {month}.html"
        filename.write_text(render_invoice(client, month, group), encoding="utf-8")
        count += 1

    print(f"Generated {count} invoices in {OUTPUT_DIR}")


if __name__ == "__main__":
    generate_invoices()
