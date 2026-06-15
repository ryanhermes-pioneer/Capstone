import io
import pandas as pd
from azure.identity import DefaultAzureCredential
from azure.storage.filedatalake import DataLakeServiceClient

WORKSPACE_ID = "a1b2c3d4-0000-0000-0000-111122223333"
LAKEHOUSE_NAME = "FinancialsLakehouse"
FILE_PATH = f"{LAKEHOUSE_NAME}.Lakehouse/Files/financials.csv"
ONELAKE_URL = "https://onelake.dfs.fabric.microsoft.com"


def load_financials() -> pd.DataFrame:
    credential = DefaultAzureCredential()
    client = DataLakeServiceClient(account_url=ONELAKE_URL, credential=credential)

    file_client = client.get_file_system_client(WORKSPACE_ID).get_file_client(FILE_PATH)
    data = file_client.download_file().readall()

    return pd.read_csv(io.BytesIO(data))


if __name__ == "__main__":
    df = load_financials()
    print(df.head())
