import sys
from pathlib import Path

from flask import Flask, Response
from flask_cors import CORS

sys.path.insert(0, str(Path(__file__).parent))
from fabric import load_financials

app = Flask(__name__)
CORS(app, origins=["http://localhost:5173", "http://127.0.0.1:5173"])


@app.route("/api/fabric-data")
def fabric_data():
    df = load_financials()
    # Normalize columns to match the expected CSV format
    df.columns = ["Client", "project", "month - Month", "Sum of revenue"]
    return Response(df.to_csv(index=False), mimetype="text/csv; charset=utf-8")


if __name__ == "__main__":
    print("Fabric data server running on http://localhost:5050")
    app.run(host="127.0.0.1", port=5050, debug=False)
