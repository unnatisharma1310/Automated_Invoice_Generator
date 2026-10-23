
import requests

url = "http://127.0.0.1:5000/api/products/999999"

try:
    response = requests.delete(url)
    print("Status Code:", response.status_code)
    print("Response:", response.json())
except requests.exceptions.ConnectionError:
    print("Flask server run nahi ho raha. Pehle python app.py run karo.")
