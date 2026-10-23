
import requests

url = "http://127.0.0.1:5000/api/products/1"

data = {
    "name": "Notebook",
    "price": 50,
    "stock_quantity": 96,
    "minimum_stock": 5
}

response = requests.put(url, json=data)

print("Status Code:", response.status_code)
print("Response:", response.json())
