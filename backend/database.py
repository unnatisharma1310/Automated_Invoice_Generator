
import os
from dotenv import load_dotenv

load_dotenv()
import mysql.connector


def get_connection():
    connection = mysql.connector.connect(
        host=os.getenv("DB_HOST", "localhost"),
        user=os.getenv("DB_USER", "root"),
        password=os.getenv("DB_PASSWORD"),
        database=os.getenv("DB_NAME", "invoice_db")
    )
    return connection


def create_tables():
    connection = get_connection()
    cursor = connection.cursor()

    try:
        # 1. Products Table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS products (
                product_id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                price DECIMAL(10,2) NOT NULL,
                stock_quantity INT NOT NULL DEFAULT 0,
                minimum_stock INT NOT NULL DEFAULT 5
            )
        """)

        # 2. Customers Table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS customers (
                customer_id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                phone VARCHAR(20),
                email VARCHAR(100),
                address TEXT
            )
        """)

        # 3. Invoices Table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS invoices (
                invoice_id INT AUTO_INCREMENT PRIMARY KEY,
                customer_id INT NOT NULL,
                invoice_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                total_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
                FOREIGN KEY (customer_id)
                    REFERENCES customers(customer_id)
            )
        """)

        # 4. Invoice Items Table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS invoice_items (
                item_id INT AUTO_INCREMENT PRIMARY KEY,
                invoice_id INT NOT NULL,
                product_id INT NOT NULL,
                quantity INT NOT NULL,
                unit_price DECIMAL(10,2) NOT NULL,
                line_total DECIMAL(10,2) NOT NULL,
                FOREIGN KEY (invoice_id)
                    REFERENCES invoices(invoice_id),
                FOREIGN KEY (product_id)
                    REFERENCES products(product_id)
            )
        """)

        # 5. Stock History Table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS stock_history (
                history_id INT AUTO_INCREMENT PRIMARY KEY,
                product_id INT NOT NULL,
                change_type VARCHAR(50) NOT NULL,
                quantity_changed INT NOT NULL,
                previous_stock INT NOT NULL,
                new_stock INT NOT NULL,
                note VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (product_id)
                    REFERENCES products(product_id)
            )
        """)

        connection.commit()
        print("MySQL tables created successfully!")

    finally:
        cursor.close()
        connection.close()


if __name__ == "__main__":
    create_tables()
