
import requests

BASE_URL = "http://127.0.0.1:5000"

# Test 1: Update Product ID 2
print("Testing Product Update API...")

update_data = {
    "price": 55,
    "stock_quantity": 100
}

response = requests.put(
    f"{BASE_URL}/api/products/2",
    json=update_data
)

print("Status:", response.status_code)
print("Response:", response.json())

# Verify updated product
response = requests.get(f"{BASE_URL}/api/products")
print("Products after update:", response.json())
