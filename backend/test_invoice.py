
import requests

BASE_URL = "http://127.0.0.1:5000"

# Get existing customer and product IDs
customers = requests.get(
    f"{BASE_URL}/api/customers"
).json()

products = requests.get(
    f"{BASE_URL}/api/products"
).json()

if not customers:
    print("Pehle ek customer add karo.")
elif not products:
    print("Pehle ek product add karo.")
else:
    customer_id = customers[0]["customer_id"]
    product = products[0]

    if product["stock_quantity"] < 1:
        print("Selected product ka stock available nahi hai.")
    else:
        invoice = {
            "customer_id": customer_id,
            "items": [
                {
                    "product_id": product["product_id"],
                    "quantity": 2
                }
            ]
        }

        response = requests.post(
            f"{BASE_URL}/api/invoices",
            json=invoice
        )

        print("Status Code:", response.status_code)
        print("Response:", response.json())

        if response.status_code == 201:
            history = requests.get(
                f"{BASE_URL}/api/invoices"
            )
            print("\nInvoice History:")
            print(history.json())
