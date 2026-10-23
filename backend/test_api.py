
import requests

BASE_URL = "http://127.0.0.1:5000"


# 1. Add a product
product_url = f"{BASE_URL}/api/products"

product = {
    "name": "Notebook",
    "price": 50,
    "stock_quantity": 100
}

response = requests.post(product_url, json=product)

print("PRODUCT TEST")
print("Status Code:", response.status_code)
print("Response:", response.json())


# 2. Display all products
response = requests.get(product_url)

print("\nALL PRODUCTS")
print("Status Code:", response.status_code)
print("Products:", response.json())


# 3. Add a customer
customer_url = f"{BASE_URL}/api/customers"

customer = {
    "name": "Rahul Sharma",
    "phone": "9876543210",
    "email": "rahul@example.com",
    "address": "Gwalior, Madhya Pradesh"
}

response = requests.post(customer_url, json=customer)

print("\nCUSTOMER TEST")
print("Status Code:", response.status_code)
print("Response:", response.json())


# 4. Display all customers
response = requests.get(customer_url)

print("\nALL CUSTOMERS")
print("Status Code:", response.status_code)
print("Customers:", response.json())
