
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
                sku VARCHAR(100) UNIQUE,
                price DECIMAL(10,2) NOT NULL,
                cost_price DECIMAL(10,2) NOT NULL DEFAULT 0,
                gst_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
                stock_quantity INT NOT NULL DEFAULT 0,
                minimum_stock INT NOT NULL DEFAULT 5
            )
        """)

        # Add missing columns to existing products table
        cursor.execute("SHOW COLUMNS FROM products")
        product_columns = {
            column[0] for column in cursor.fetchall()
        }

        if "sku" not in product_columns:
            cursor.execute("""
                ALTER TABLE products
                ADD COLUMN sku VARCHAR(100) NULL
            """)

        if "cost_price" not in product_columns:
            cursor.execute("""
                ALTER TABLE products
                ADD COLUMN cost_price DECIMAL(10,2)
                NOT NULL DEFAULT 0
            """)

        if "gst_rate" not in product_columns:
            cursor.execute("""
                ALTER TABLE products
                ADD COLUMN gst_rate DECIMAL(5,2)
                NOT NULL DEFAULT 0
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
                status VARCHAR(20) NOT NULL DEFAULT 'Pending',
                FOREIGN KEY (customer_id)
                    REFERENCES customers(customer_id)
            )
        """)
        
        
        # Add missing invoice amount columns to existing databases
        cursor.execute("SHOW COLUMNS FROM invoices")
        invoice_columns = {
            column[0] for column in cursor.fetchall()
        }

        if "discount_amount" not in invoice_columns:
            cursor.execute("""
                ALTER TABLE invoices
                ADD COLUMN discount_amount DECIMAL(10,2)
                NOT NULL DEFAULT 0
            """)

        if "tax_amount" not in invoice_columns:
            cursor.execute("""
                ALTER TABLE invoices
                ADD COLUMN tax_amount DECIMAL(10,2)
                NOT NULL DEFAULT 0
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
        
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS product_batches (
                batch_id INT AUTO_INCREMENT PRIMARY KEY,
                product_id INT NOT NULL,
                batch_number VARCHAR(100) NOT NULL,
                quantity INT NOT NULL DEFAULT 0,
                expiry_date DATE NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY unique_product_batch (product_id, batch_number),
                FOREIGN KEY (product_id)
                    REFERENCES products(product_id)
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS expenses (
                expense_id INT AUTO_INCREMENT PRIMARY KEY,
                title VARCHAR(150) NOT NULL,
                category VARCHAR(100),
                amount DECIMAL(10,2) NOT NULL,
                expense_date DATE NOT NULL,
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS payments (
                payment_id INT AUTO_INCREMENT PRIMARY KEY,
                invoice_id INT NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                payment_method VARCHAR(50) DEFAULT 'Cash',
                payment_date DATE NOT NULL,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (invoice_id)
                    REFERENCES invoices(invoice_id)
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS business_settings (
                setting_id INT AUTO_INCREMENT PRIMARY KEY,
                business_name VARCHAR(150) NOT NULL,
                address TEXT,
                phone VARCHAR(20),
                email VARCHAR(100),
                gst_number VARCHAR(30),
                currency VARCHAR(10) DEFAULT 'INR',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    ON UPDATE CURRENT_TIMESTAMP
            )
        """)


        connection.commit()
        print("MySQL tables created successfully!")

    finally:
        cursor.close()
        connection.close()


if __name__ == "__main__":
    create_tables()
