from flask_cors import CORS
from flask import send_file
from io import BytesIO
from flask import Flask, jsonify, request
from database import get_connection, create_tables
from decimal import Decimal

app = Flask(__name__)
CORS(app)

# Home route
@app.route("/")
def home():
    return jsonify({
        "message": "Automated Invoice Generator Backend is running!"
    })


# ---------------- PRODUCTS API ----------------

# Get all products
@app.route("/api/products", methods=["GET"])
def get_products():
    connection = get_connection()
    cursor = connection.cursor(dictionary=True)

    cursor.execute("SELECT * FROM products")
    products = cursor.fetchall()

    cursor.close()
    connection.close()

    return jsonify(products)


# ---------------- PRODUCT SEARCH & FILTER API ----------------

@app.route("/api/products/search", methods=["GET"])
def search_products():
    search_name = request.args.get("name", "").strip()
    min_price = request.args.get("min_price")
    max_price = request.args.get("max_price")

    query = "SELECT * FROM products WHERE name LIKE %s"
    values = [f"%{search_name}%"]

    try:
        if min_price is not None:
            min_price = float(min_price)
            if min_price < 0:
                raise ValueError
            query += " AND price >= %s"
            values.append(min_price)

        if max_price is not None:
            max_price = float(max_price)
            if max_price < 0:
                raise ValueError
            query += " AND price <= %s"
            values.append(max_price)

        if min_price is not None and max_price is not None:
            if min_price > max_price:
                return jsonify({
                    "error": "min_price cannot exceed max_price"
                }), 400

        query += " ORDER BY name ASC"

        connection = get_connection()
        cursor = connection.cursor(dictionary=True)

        try:
            cursor.execute(query, tuple(values))
            products = cursor.fetchall()

            return jsonify({
                "count": len(products),
                "products": products
            }), 200

        finally:
            cursor.close()
            connection.close()

    except (ValueError, TypeError):
        return jsonify({
            "error": "Price filters must be valid non-negative numbers"
        }), 400



# Add a new product with SKU, cost, GST and optional initial batch
@app.route("/api/products", methods=["POST"])
def add_product():
    from datetime import date
    from decimal import Decimal, InvalidOperation

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({"error": "Valid JSON data is required"}), 400

    name = data.get("name")
    sku = (data.get("sku") or "").strip() or None
    batch_number = (data.get("batch_number") or "").strip() or None
    expiry_date = data.get("expiry_date") or None

    try:
        if not isinstance(name, str) or not name.strip():
            raise ValueError("Product name is required")

        price = Decimal(str(data.get("price")))
        cost_price = Decimal(str(data.get("cost_price", 0)))
        gst_rate = Decimal(str(data.get("gst_rate", 0)))

        stock = data.get("stock_quantity", 0)
        minimum_stock = data.get("minimum_stock", 5)

        if isinstance(stock, bool) or isinstance(minimum_stock, bool):
            raise ValueError("Stock values must be integers")

        if isinstance(stock, float) and not stock.is_integer():
            raise ValueError("Stock must be a whole number")

        if isinstance(minimum_stock, float) and not minimum_stock.is_integer():
            raise ValueError("Minimum stock must be a whole number")

        stock = int(stock)
        minimum_stock = int(minimum_stock)

        if price < 0 or cost_price < 0:
            raise ValueError("Prices cannot be negative")

        if not Decimal("0") <= gst_rate <= Decimal("100"):
            raise ValueError("GST must be between 0 and 100")

        if stock < 0 or minimum_stock < 0:
            raise ValueError("Stock values cannot be negative")

        if stock > 0 and not batch_number:
            raise ValueError(
                "Enter an initial batch number when opening stock is greater than zero"
            )

        if expiry_date:
            expiry_date = date.fromisoformat(expiry_date).isoformat()

    except (ValueError, TypeError, InvalidOperation) as error:
        return jsonify({"error": str(error) or "Invalid product details"}), 400

    connection = None
    cursor = None

    try:
        connection = get_connection()
        cursor = connection.cursor()
        connection.start_transaction()

        cursor.execute("""
            INSERT INTO products
                (name, sku, price, cost_price, gst_rate,
                 stock_quantity, minimum_stock)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        """, (
            name.strip(),
            sku,
            str(price),
            str(cost_price),
            str(gst_rate),
            stock,
            minimum_stock
        ))

        product_id = cursor.lastrowid

        # Save the opening batch when a batch number is supplied.
        if batch_number:
            cursor.execute("""
                INSERT INTO product_batches
                    (product_id, batch_number, quantity, expiry_date)
                VALUES (%s, %s, %s, %s)
            """, (
                product_id,
                batch_number,
                stock,
                expiry_date
            ))

        # Record opening stock once.
        if stock > 0:
            cursor.execute("""
                INSERT INTO stock_history
                    (product_id, change_type, quantity_changed,
                     previous_stock, new_stock, note)
                VALUES (%s, %s, %s, %s, %s, %s)
            """, (
                product_id,
                "OPENING_STOCK",
                stock,
                0,
                stock,
                f"Initial stock for product {name.strip()}"
            ))

        connection.commit()

        return jsonify({
            "message": "Product added successfully",
            "product_id": product_id
        }), 201

    except Exception as error:
        if connection:
            connection.rollback()

        app.logger.exception("Could not add product")

        if getattr(error, "errno", None) == 1062:
            return jsonify({
                "error": "This SKU or batch number already exists"
            }), 409

        return jsonify({"error": "Could not add product"}), 500

    finally:
        if cursor:
            cursor.close()
        if connection:
            connection.close()


# Update an existing product
@app.route("/api/products/<int:product_id>", methods=["PUT"])
def update_product(product_id):
    data = request.get_json(silent=True)

    if not isinstance(data, dict) or not data:
        return jsonify({"error": "JSON data is required"}), 400

    allowed_fields = {
        "name",
        "sku",
        "price",
        "cost_price",
        "gst_rate",
        "minimum_stock"
    }
    if not any(field in data for field in allowed_fields):
        return jsonify({"error": "At least one valid field is required"}), 400

    updates = []
    values = []

    if "name" in data:
        name = data["name"]
        if not isinstance(name, str) or not name.strip():
            return jsonify({"error": "Name cannot be empty"}), 400
        updates.append("name = %s")
        values.append(name.strip())
        
        
    if "name" in data:
        name = data["name"]
        if not isinstance(name, str) or not name.strip():
            return jsonify({"error": "Name cannot be empty"}), 400
        updates.append("name = %s")
        values.append(name.strip())

    # SKU update support — YAHAN ADD KARNA HAI
    if "sku" in data:
        sku = data["sku"]

        if sku is not None and not isinstance(sku, str):
            return jsonify({"error": "Invalid SKU"}), 400

        updates.append("sku = %s")
        values.append(sku.strip() if sku else None)


    for field in ("price", "cost_price", "gst_rate", "minimum_stock"):
        if field in data:
            try:
                value = data[field]
                if isinstance(value, bool):
                    raise ValueError

                if field == "price":
                    value = float(value)
                else:
                    if isinstance(value, float) and not value.is_integer():
                        raise ValueError
                    value = int(value)

                if value < 0:
                    raise ValueError
                
                if field == "gst_rate" and value > 100:
                    return jsonify({
                        "error": "GST rate cannot exceed 100%"
                    }), 400

            except (ValueError, TypeError):
                return jsonify({"error": f"Invalid {field}"}), 400

            updates.append(f"{field} = %s")
            values.append(value)

    connection = get_connection()
    cursor = connection.cursor()

    try:
        cursor.execute(
            "SELECT product_id FROM products WHERE product_id = %s",
            (product_id,)
        )

        if cursor.fetchone() is None:
            return jsonify({"error": "Product not found"}), 404

        values.append(product_id)

        cursor.execute(
            f"UPDATE products SET {', '.join(updates)} "
            "WHERE product_id = %s",
            tuple(values)
        )

        connection.commit()

        return jsonify({
            "message": "Product updated successfully!",
            "product_id": product_id
        }), 200

    except Exception:
        connection.rollback()
        app.logger.exception("Product update failed")
        return jsonify({"error": "Product could not be updated"}), 500

    finally:
        cursor.close()
        connection.close()


# Delete an existing product
@app.route("/api/products/<int:product_id>", methods=["DELETE"])
def delete_product(product_id):
    connection = get_connection()
    cursor = connection.cursor()

    try:
        cursor.execute(
            "SELECT product_id FROM products WHERE product_id = %s",
            (product_id,)
        )

        if cursor.fetchone() is None:
            return jsonify({"error": "Product not found"}), 404

        cursor.execute(
            "DELETE FROM products WHERE product_id = %s",
            (product_id,)
        )

        connection.commit()

        return jsonify({
            "message": "Product deleted successfully!",
            "product_id": product_id
        }), 200

    except Exception:
        connection.rollback()
        app.logger.exception("Product deletion failed")
        return jsonify({
            "error": "Product could not be deleted. "
                     "It may be linked to existing invoices or stock history."
        }), 409

    finally:
        cursor.close()
        connection.close()


# ---------------- CUSTOMERS API ----------------

# Get all customers
@app.route("/api/customers", methods=["GET"])
def get_customers():
    connection = get_connection()
    cursor = connection.cursor(dictionary=True)

    cursor.execute("SELECT * FROM customers")
    customers = cursor.fetchall()

    cursor.close()
    connection.close()

    return jsonify(customers)


# Add a new customer
@app.route("/api/customers", methods=["POST"])
def add_customer():
    data = request.get_json(silent=True)

    if not data:
        return jsonify({"error": "JSON data is required"}), 400

    name = data.get("name")

    if not isinstance(name, str) or not name.strip():
        return jsonify({
            "error": "Customer name is required"
        }), 400

    phone = data.get("phone")
    email = data.get("email")
    address = data.get("address")

    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute(
        """
        INSERT INTO customers (name, phone, email, address)
        VALUES (%s, %s, %s, %s)
        """,
        (name.strip(), phone, email, address)
    )

    connection.commit()
    customer_id = cursor.lastrowid

    cursor.close()
    connection.close()

    return jsonify({
        "message": "Customer added successfully!",
        "customer_id": customer_id
    }), 201


# ---------------- UPDATE CUSTOMER API ----------------

@app.route("/api/customers/<int:customer_id>", methods=["PUT"])
def update_customer(customer_id):
    data = request.get_json(silent=True)

    if not isinstance(data, dict) or not data:
        return jsonify({"error": "Valid JSON data required"}), 400

    allowed_fields = {"name", "phone", "email", "address"}
    updates = []
    values = []

    for field in allowed_fields:
        if field not in data:
            continue

        value = data[field]

        if field == "name":
            if not isinstance(value, str) or not value.strip():
                return jsonify({"error": "Customer name is required"}), 400
            value = value.strip()

        updates.append(f"{field} = %s")
        values.append(value)

    if not updates:
        return jsonify({"error": "No valid fields provided"}), 400

    connection = get_connection()
    cursor = connection.cursor()

    try:
        cursor.execute(
            "SELECT customer_id FROM customers WHERE customer_id = %s",
            (customer_id,)
        )

        if cursor.fetchone() is None:
            return jsonify({"error": "Customer not found"}), 404

        values.append(customer_id)

        cursor.execute(
            f"UPDATE customers SET {', '.join(updates)} "
            "WHERE customer_id = %s",
            tuple(values)
        )

        connection.commit()

        return jsonify({
            "message": "Customer updated successfully",
            "customer_id": customer_id
        }), 200

    except Exception:
        connection.rollback()
        app.logger.exception("Customer update failed")
        return jsonify({"error": "Customer could not be updated"}), 500

    finally:
        cursor.close()
        connection.close()


# ---------------- DELETE CUSTOMER API ----------------

@app.route("/api/customers/<int:customer_id>", methods=["DELETE"])
def delete_customer(customer_id):
    connection = get_connection()
    cursor = connection.cursor()

    try:
        cursor.execute(
            "DELETE FROM customers WHERE customer_id = %s",
            (customer_id,)
        )

        if cursor.rowcount == 0:
            return jsonify({"error": "Customer not found"}), 404

        connection.commit()

        return jsonify({
            "message": "Customer deleted successfully",
            "customer_id": customer_id
        }), 200

    except Exception:
        connection.rollback()
        app.logger.exception("Customer deletion failed")
        return jsonify({
            "error": "Customer could not be deleted. "
                     "The customer may have existing invoices."
        }), 409

    finally:
        cursor.close()
        connection.close()


# ---------------- INVOICE GENERATION API ----------------


@app.route("/api/invoices", methods=["POST"])
def create_invoice():
    from decimal import Decimal, InvalidOperation

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({"error": "Valid JSON data required"}), 400

    customer_id = data.get("customer_id")
    items = data.get("items")
    
    discount_rate = Decimal(str(data.get("discount_rate", 0)))
    gst_rate = Decimal(str(data.get("gst_rate", 0)))

    if not (Decimal("0") <= discount_rate <= Decimal("100")):
        return jsonify({"error": "Discount must be between 0 and 100."}), 400

    if not (Decimal("0") <= gst_rate <= Decimal("100")):
        return jsonify({"error": "GST rate must be between 0 and 100."}), 400
    
    if customer_id is None or not isinstance(items, list) or not items:
        return jsonify({
            "error": "Customer ID and invoice items are required"
        }), 400

    try:    
        if isinstance(customer_id, bool):
            raise ValueError

        customer_id = int(customer_id)

        if customer_id <= 0:
            raise ValueError

        validated_items = []

        for item in items:
            if not isinstance(item, dict):
                raise ValueError

            product_id = item.get("product_id")
            quantity = item.get("quantity")

            if isinstance(product_id, bool) or isinstance(quantity, bool):
                raise ValueError

            product_id = int(product_id)
            quantity = int(quantity)

            if product_id <= 0 or quantity <= 0:
                raise ValueError

            validated_items.append((product_id, quantity))

    except (ValueError, TypeError, KeyError):
        return jsonify({
            "error": "Invalid customer, product or quantity"
        }), 400

    connection = get_connection()
    cursor = connection.cursor(dictionary=True)

    try:
        connection.start_transaction()

        cursor.execute(
            "SELECT customer_id FROM customers WHERE customer_id = %s",
            (customer_id,)
        )

        if cursor.fetchone() is None:
            connection.rollback()
            return jsonify({"error": "Customer not found"}), 404

        cursor.execute("""
            INSERT INTO invoices (customer_id, total_amount, status)
            VALUES (%s, 0, 'Pending')
        """, (customer_id,))

        invoice_id = cursor.lastrowid
        total_amount = Decimal("0.00")

        for product_id, quantity in validated_items:
            # Lock product row to prevent concurrent stock changes.
            cursor.execute("""
                SELECT product_id, name, price, stock_quantity
                FROM products
                WHERE product_id = %s
                FOR UPDATE
            """, (product_id,))

            product = cursor.fetchone()

            if product is None:
                connection.rollback()
                return jsonify({
                    "error": f"Product ID {product_id} not found"
                }), 404

            previous_stock = int(product["stock_quantity"])
            
            if previous_stock < quantity:
                connection.rollback()
                return jsonify({
                    "error": f"Insufficient stock for {product['name']}"
                }), 400

            # If batches exist, deduct earliest-expiring batches first.
            cursor.execute("""
                SELECT batch_id, quantity, expiry_date
                FROM product_batches
                WHERE product_id = %s AND quantity > 0
                ORDER BY
                    CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END,
                    expiry_date ASC,
                    batch_id ASC
                FOR UPDATE
            """, (product_id,))

            batches = cursor.fetchall()

            if batches:
                batch_stock = sum(
                    int(batch["quantity"]) for batch in batches
                )

                if batch_stock < quantity:
                    connection.rollback()
                    return jsonify({
                        "error": (
                            f"Insufficient batch stock for {product['name']}"
                        )
                    }), 400

                remaining = quantity

                for batch in batches:
                    if remaining <= 0:
                        break

                    available = int(batch["quantity"])
                    deduction = min(available, remaining)

                    cursor.execute("""
                        UPDATE product_batches
                        SET quantity = quantity - %s
                        WHERE batch_id = %s
                    """, (deduction, batch["batch_id"]))

                    remaining -= deduction

            # Record invoice item whether batches exist or not.
            unit_price = Decimal(str(product["price"]))
            line_total = (unit_price * quantity).quantize(
            Decimal("0.01")
            )
            total_amount += line_total

            cursor.execute("""
                INSERT INTO invoice_items
                    (invoice_id, product_id, quantity, unit_price, line_total)
                VALUES (%s, %s, %s, %s, %s)
            """, (
                invoice_id,
                product_id,
                quantity,
                str(unit_price),
                str(line_total)
            ))

            # Update overall product stock.
            new_stock = previous_stock - quantity

            cursor.execute("""
                UPDATE products
                SET stock_quantity = %s
                WHERE product_id = %s
            """, (new_stock, product_id))

            # Record stock movement.
            cursor.execute("""
                INSERT INTO stock_history
                    (product_id, change_type, quantity_changed,
                     previous_stock, new_stock, note)
                VALUES (%s, %s, %s, %s, %s, %s)
            """, (
                product_id,
                "SALE",
                quantity,
                previous_stock,
                new_stock,
                f"Stock reduced for invoice #{invoice_id}"
            ))

        # Calculate discount, GST and final invoice total
        subtotal = total_amount.quantize(Decimal("0.01"))

        discount_amount = (
            subtotal * discount_rate / Decimal("100")
        ).quantize(Decimal("0.01"))

        taxable_amount = subtotal - discount_amount

        tax_amount = (
            taxable_amount * gst_rate / Decimal("100")
        ).quantize(Decimal("0.01"))

        final_total = (
            taxable_amount + tax_amount
        ).quantize(Decimal("0.01"))

        # Save final invoice amounts in MySQL
        cursor.execute("""
            UPDATE invoices
            SET total_amount = %s,
                discount_amount = %s,
                tax_amount = %s
            WHERE invoice_id = %s
        """, (
            str(final_total),
            str(discount_amount),
            str(tax_amount),
            invoice_id
        ))

        connection.commit()

        return jsonify({
            "message": "Invoice created successfully!",
            "invoice_id": invoice_id,
            "customer_id": customer_id,
            "subtotal": float(subtotal),
            "discount_amount": float(discount_amount),
            "tax_amount": float(tax_amount),
            "total_amount": float(final_total),
            "status": "Pending"
        }), 201

    except Exception:
        connection.rollback()
        app.logger.exception("Invoice creation failed")
        return jsonify({
            "error": "Invoice could not be created. Check server logs."
        }), 500

    
    finally:
        cursor.close()
        connection.close()




# Get invoice history with payment status and paid amount

@app.route("/api/invoices", methods=["GET"])
def get_invoices():
    connection = get_connection()
    cursor = connection.cursor(dictionary=True)

    try:
        cursor.execute("""
            SELECT
                i.invoice_id,
                i.customer_id,
                c.name AS customer_name,
                i.invoice_date,
                i.total_amount,
                i.discount_amount,
                i.tax_amount,
                COALESCE(i.status, 'Pending') AS status,
                COALESCE(
                    (
                        SELECT SUM(pay.amount)
                        FROM payments pay
                        WHERE pay.invoice_id = i.invoice_id
                    ),
                    0
                ) AS amount_paid
            FROM invoices i
            JOIN customers c
                ON c.customer_id = i.customer_id
            ORDER BY i.invoice_id DESC
        """)

        invoices = cursor.fetchall()

        for invoice in invoices:
            invoice_id = invoice["invoice_id"]

            if invoice["invoice_date"]:
                invoice["invoice_date"] = (
                    invoice["invoice_date"].isoformat()
                )

            invoice["total_amount"] = float(
                invoice["total_amount"] or 0
            )
            invoice["discount_amount"] = float(
                invoice["discount_amount"] or 0
            )
            invoice["tax_amount"] = float(
                invoice["tax_amount"] or 0
            )
            invoice["amount_paid"] = float(
                invoice["amount_paid"] or 0
            )

            cursor.execute("""
                SELECT
                    ii.product_id,
                    p.name AS product_name,
                    ii.quantity,
                    ii.unit_price,
                    ii.line_total
                FROM invoice_items ii
                JOIN products p
                    ON p.product_id = ii.product_id
                WHERE ii.invoice_id = %s
            """, (invoice_id,))

            items = cursor.fetchall()

            for item in items:
                item["product_id"] = int(item["product_id"])
                item["quantity"] = int(item["quantity"])
                item["unit_price"] = float(item["unit_price"] or 0)
                item["line_total"] = float(item["line_total"] or 0)

            invoice["items"] = items

            total = invoice["total_amount"]
            paid = invoice["amount_paid"]

            if total > 0 and paid >= total:
                invoice["status"] = "Paid"
            elif paid > 0:
                invoice["status"] = "Partial"
            else:
                invoice["status"] = "Pending"

        return jsonify(invoices), 200

    except Exception:
        app.logger.exception("Could not fetch invoice history")
        return jsonify({
            "error": "Could not fetch invoice history"
        }), 500

    finally:
        cursor.close()
        connection.close()


# ---------------- INVOICE DETAILS API ----------------

@app.route("/api/invoices/<int:invoice_id>", methods=["GET"])
def get_invoice_details(invoice_id):
    connection = get_connection()
    cursor = connection.cursor(dictionary=True)

    try:
        cursor.execute("""
            SELECT
                i.invoice_id,
                i.customer_id,
                c.name AS customer_name,
                c.phone AS customer_phone,
                c.email AS customer_email,
                c.address AS customer_address,
                i.invoice_date,
                i.total_amount,
                i.discount_amount,
                i.tax_amount,
                i.status
            FROM invoices i
            JOIN customers c ON c.customer_id = i.customer_id
            WHERE i.invoice_id = %s
        """, (invoice_id,))

        invoice = cursor.fetchone()

        if invoice is None:
            return jsonify({"error": "Invoice not found"}), 404

        cursor.execute("""
            SELECT
                ii.item_id,
                ii.product_id,
                p.name AS product_name,
                ii.quantity,
                ii.unit_price,
                ii.line_total
            FROM invoice_items ii
            JOIN products p ON p.product_id = ii.product_id
            WHERE ii.invoice_id = %s
            ORDER BY ii.item_id
        """, (invoice_id,))

        items = cursor.fetchall()

        for item in items:
            item["unit_price"] = float(item["unit_price"] or 0)
            item["line_total"] = float(item["line_total"] or 0)

        for field in ("total_amount", "discount_amount", "tax_amount"):
            invoice[field] = float(invoice.get(field) or 0)

        if invoice.get("invoice_date"):
            invoice["invoice_date"] = invoice["invoice_date"].isoformat()

        invoice["items"] = items

        return jsonify(invoice), 200

    except Exception:
        app.logger.exception("Could not fetch invoice details")
        return jsonify({"error": "Could not fetch invoice details"}), 500

    finally:
        cursor.close()
        connection.close()


# ---------------- PDF INVOICE GENERATION API ----------------

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
)


@app.route("/api/invoices/<int:invoice_id>/pdf", methods=["GET"])
def download_invoice_pdf(invoice_id):
    connection = get_connection()
    cursor = connection.cursor(dictionary=True)

    try:
        # Get invoice and customer details
        cursor.execute("""
            SELECT
                i.invoice_id,
                i.invoice_date,
                i.total_amount,
                i.discount_amount,
                i.tax_amount,
                c.name AS customer_name,
                c.phone AS customer_phone,
                c.email AS customer_email,
                c.address AS customer_address
            FROM invoices i
            JOIN customers c ON i.customer_id = c.customer_id
            WHERE i.invoice_id = %s
        """, (invoice_id,))

        invoice = cursor.fetchone()

        if invoice is None:
            return jsonify({"error": "Invoice not found"}), 404
        
        # Fetch saved business details
        cursor.execute("""
            SELECT
                business_name,
                address,
                phone,
                email,
                gst_number,
                currency
            FROM business_settings
            ORDER BY setting_id DESC
            LIMIT 1
        """)

        business = cursor.fetchone() or {}

        # Get invoice items
        cursor.execute("""
            SELECT
                p.name AS product_name,
                ii.quantity,
                ii.unit_price,
                ii.line_total
            FROM invoice_items ii
            JOIN products p ON ii.product_id = p.product_id
            WHERE ii.invoice_id = %s
        """, (invoice_id,))

        items = cursor.fetchall()
        
        # Fetch payment summary for this invoice
        cursor.execute("""        
            SELECT
                COALESCE(SUM(amount), 0) AS amount_paid
            FROM payments
            WHERE invoice_id = %s
        """, (invoice_id,))

        payment_summary = cursor.fetchone() or {}

        amount_paid = float(payment_summary.get("amount_paid") or 0)
        grand_total = float(invoice.get("total_amount") or 0)
        balance_due = max(0, round(grand_total - amount_paid, 2))

        if balance_due <= 0:        
            payment_status = "Paid"
        elif amount_paid > 0:        
            payment_status = "Partially Paid"
        else:
            payment_status = "Pending"

        # Build PDF in memory
        pdf_buffer = BytesIO()

        document = SimpleDocTemplate(
            pdf_buffer,
            pagesize=A4,
            rightMargin=20 * mm,
            leftMargin=20 * mm,
            topMargin=20 * mm,
            bottomMargin=20 * mm
        )

        styles = getSampleStyleSheet()
        story = []

        business_name = business.get("business_name") or "AUTOMATED INVOICE GENERATOR"

        story.append(Paragraph(
            business_name,
            styles["Title"]
        ))

        if business.get("address"):
            story.append(Paragraph(
                f"Address: {business['address']}",
                styles["Normal"]
            ))

        if business.get("phone"):
            story.append(Paragraph(
                f"Phone: {business['phone']}",
                styles["Normal"]
            ))

        if business.get("email"):
            story.append(Paragraph(
                f"Email: {business['email']}",
                styles["Normal"]
            ))

        story.append(Spacer(1, 8 * mm))

        story.append(Paragraph(
            f"Invoice Number: INV-{invoice['invoice_id']}",
            styles["Heading2"]
        ))

        invoice_date = invoice["invoice_date"]
        if invoice_date:
            invoice_date = invoice_date.strftime("%d-%m-%Y %H:%M")
        else:
            invoice_date = "N/A"

        story.append(Paragraph(
            f"Invoice Date: {invoice_date}",
            styles["Normal"]
        ))
        story.append(Spacer(1, 5 * mm))

        story.append(Paragraph(
            f"Customer: {invoice['customer_name']}",
            styles["Normal"]
        ))

        if invoice.get("customer_phone"):
            story.append(Paragraph(
                f"Phone: {invoice['customer_phone']}",
                styles["Normal"]
            ))

        if invoice.get("customer_email"):
            story.append(Paragraph(
                f"Email: {invoice['customer_email']}",
                styles["Normal"]
            ))

        if invoice.get("customer_address"):
            story.append(Paragraph(
                f"Address: {invoice['customer_address']}",
                styles["Normal"]
            ))

        story.append(Spacer(1, 8 * mm))

        table_data = [
            ["Product", "Quantity", "Unit Price", "Total"]
        ]

        for item in items:
            table_data.append([
                str(item["product_name"]),
                str(item["quantity"]),
                f"Rs. {float(item['unit_price']):.2f}",
                f"Rs. {float(item['line_total']):.2f}"
            ])

        table = Table(
            table_data,
            colWidths=[75 * mm, 25 * mm, 30 * mm, 30 * mm],
            repeatRows=1
        )

        table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#4058df")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
            ("ALIGN", (1, 1), (-1, -1), "RIGHT"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("PADDING", (0, 0), (-1, -1), 7),
        ]))
        
        
        story.append(table)
        story.append(Spacer(1, 8 * mm))

        subtotal = sum(float(item["line_total"]) for item in items)
        discount_amount = float(invoice.get("discount_amount") or 0)
        tax_amount = float(invoice.get("tax_amount") or 0)
        grand_total = float(invoice["total_amount"])

        story.append(Paragraph(
            f"Subtotal: Rs. {subtotal:.2f}",
            styles["Normal"]
        ))
        story.append(Paragraph(
            f"Discount: Rs. {discount_amount:.2f}",
            styles["Normal"]
        ))
        story.append(Paragraph(
            f"GST / Tax: Rs. {tax_amount:.2f}",
            styles["Normal"]
        ))
        story.append(Spacer(1, 3 * mm))
        story.append(Paragraph(
            f"<b>Grand Total: Rs. {grand_total:.2f}</b>",
            styles["Heading2"]
        ))
        
        story.append(Spacer(1, 4 * mm))

        story.append(Paragraph(
            f"<b>Payment Status: {payment_status}</b>",
            styles["Normal"]
        ))

        story.append(Paragraph(
            f"Amount Paid: Rs. {amount_paid:.2f}",
            styles["Normal"]
        ))

        story.append(Paragraph(
            f"<b>Balance Due: Rs. {balance_due:.2f}</b>",
            styles["Heading3"]
        ))
        
        document.build(story)

        pdf_buffer.seek(0)

        return send_file(
            pdf_buffer,
            mimetype="application/pdf",
            as_attachment=True,
            download_name=f"invoice_{invoice_id}.pdf"
        )

    except Exception:
        app.logger.exception("PDF invoice generation failed")
        return jsonify({
            "error": "PDF could not be generated. Check server logs."
        }), 500

    finally:
        cursor.close()
        connection.close()


# ---------------- LOW STOCK ALERT API ----------------

@app.route("/api/low-stock", methods=["GET"])
def get_low_stock():
    connection = get_connection()
    cursor = connection.cursor(dictionary=True)

    try:
        cursor.execute("""
            SELECT
                product_id,
                name,
                stock_quantity,
                minimum_stock
            FROM products
            WHERE stock_quantity <= minimum_stock
            ORDER BY stock_quantity ASC
        """)

        products = cursor.fetchall()

        return jsonify({
            "count": len(products),
            "low_stock_products": products
        })

    finally:
        cursor.close()
        connection.close()


# ---------------- STOCK HISTORY API ----------------

@app.route("/api/stock-history", methods=["GET"])
def get_stock_history():
    connection = get_connection()
    cursor = connection.cursor(dictionary=True)

    try:
        cursor.execute("""
            SELECT
                sh.history_id,
                p.name AS product_name,
                sh.change_type,
                sh.quantity_changed,
                sh.previous_stock,
                sh.new_stock,
                sh.note,
                sh.created_at
            FROM stock_history sh
            JOIN products p
                ON sh.product_id = p.product_id
            ORDER BY sh.created_at DESC, sh.history_id DESC
        """)

        history = cursor.fetchall()

        return jsonify({
            "count": len(history),
            "stock_history": history
        })

    finally:
        cursor.close()
        connection.close()


@app.route("/api/analytics/summary", methods=["GET"])
def sales_analytics():
    conn = None
    cursor = None

    try:
        conn = get_connection()
        cursor = conn.cursor(dictionary=True)

        # 1. Total sales aur total invoices
        
        cursor.execute("""
            SELECT
                COALESCE(SUM(total_amount), 0) AS total_sales,
                COUNT(*) AS total_invoices,
                SUM(CASE WHEN status = 'Paid' THEN 1 ELSE 0 END) AS paid_invoices,
                SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) AS pending_invoices
            FROM invoices
        """)
        summary = cursor.fetchone()


        # 2. Monthly sales - last 12 months
        cursor.execute("""
            SELECT
                DATE_FORMAT(invoice_date, '%Y-%m') AS month,
                COALESCE(SUM(total_amount), 0) AS sales
            FROM invoices
            WHERE invoice_date >=
                DATE_SUB(CURDATE(), INTERVAL 11 MONTH)
            GROUP BY DATE_FORMAT(invoice_date, '%Y-%m')
            ORDER BY month
        """)
        monthly_sales = cursor.fetchall()

        # 3. Top 5 selling products
        cursor.execute("""
            SELECT
                p.product_id,
                p.name AS product_name,
                COALESCE(SUM(ii.quantity), 0) AS quantity_sold,
                COALESCE(SUM(ii.line_total), 0) AS revenue
            FROM invoice_items ii
            JOIN products p
                ON ii.product_id = p.product_id
            GROUP BY p.product_id, p.name
            ORDER BY quantity_sold DESC
            LIMIT 5
        """)
        top_products = cursor.fetchall()

        # 4. Low stock products count
        cursor.execute("""
            SELECT COUNT(*) AS low_stock_count
            FROM products
            WHERE stock_quantity <= minimum_stock
        """)
        low_stock = cursor.fetchone()

        # Decimal values ko JSON-friendly float mein convert karna
        return jsonify({
            "total_sales": float(summary["total_sales"]),
            "total_invoices": int(summary["total_invoices"]),
            "paid_invoices": int(summary["paid_invoices"] or 0),
            "pending_invoices": int(summary["pending_invoices"] or 0),
            "monthly_sales": [
                {
                    "month": row["month"],
                    "sales": float(row["sales"])
                }
                for row in monthly_sales
            ],
            "top_products": [
                {
                    "product_id": int(row["product_id"]),
                    "product_name": row["product_name"],
                    "quantity_sold": int(row["quantity_sold"]),
                    "revenue": float(row["revenue"])
                }
                for row in top_products
            ],
            "low_stock_count": int(low_stock["low_stock_count"])
        }), 200

    except Exception as e:
        return jsonify({
            "error": "Sales analytics fetch karne mein problem hui.",
            "details": str(e)
        }), 500

    finally:
        if cursor is not None:
            cursor.close()
        if conn is not None:
            conn.close()


# ---------------- BATCH & EXPIRY MANAGEMENT APIs ----------------

from datetime import date



# Add a batch and synchronize product stock
@app.route("/api/batches", methods=["POST"])
def add_batch():
    from datetime import date

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({"error": "Valid JSON data is required"}), 400

    product_id = data.get("product_id")
    batch_number = data.get("batch_number")
    quantity = data.get("quantity", 0)
    expiry_date = data.get("expiry_date")

    try:
        if isinstance(product_id, bool) or isinstance(quantity, bool):
            raise ValueError

        product_id = int(product_id)
        quantity = int(quantity)

        if product_id <= 0 or quantity < 0:
            raise ValueError

        if not isinstance(batch_number, str) or not batch_number.strip():
            raise ValueError

        if isinstance(quantity, float) and not quantity.is_integer():
            raise ValueError

        if expiry_date:
            expiry_date = date.fromisoformat(expiry_date).isoformat()
        else:
            expiry_date = None

    except (ValueError, TypeError):
        return jsonify({
            "error": "Invalid product ID, batch number, quantity or expiry date"
        }), 400

    connection = get_connection()
    cursor = connection.cursor(dictionary=True)

    try:
        connection.start_transaction()

        cursor.execute("""
            SELECT product_id, stock_quantity
            FROM products
            WHERE product_id = %s
            FOR UPDATE
        """, (product_id,))

        product = cursor.fetchone()

        if product is None:
            connection.rollback()
            return jsonify({"error": "Product not found"}), 404

        previous_stock = int(product["stock_quantity"])
        new_stock = previous_stock + quantity

        cursor.execute("""
            INSERT INTO product_batches
                (product_id, batch_number, quantity, expiry_date)
            VALUES (%s, %s, %s, %s)
        """, (
            product_id,
            batch_number.strip(),
            quantity,
            expiry_date
        ))

        batch_id = cursor.lastrowid

        cursor.execute("""
            UPDATE products
            SET stock_quantity = %s
            WHERE product_id = %s
        """, (new_stock, product_id))

        if quantity > 0:
            cursor.execute("""
                INSERT INTO stock_history (
                    product_id,
                    change_type,
                    quantity_changed,
                    previous_stock,
                    new_stock,
                    note
                )
                VALUES (%s, %s, %s, %s, %s, %s)
            """, (
                product_id,
                "BATCH_IN",
                quantity,
                previous_stock,
                new_stock,
                f"Stock added from batch {batch_number.strip()}"
            ))

        connection.commit()

        return jsonify({
            "message": "Batch added and product stock synchronized",
            "batch_id": batch_id,
            "product_id": product_id,
            "previous_stock": previous_stock,
            "new_stock": new_stock
        }), 201

    except Exception as e:
        connection.rollback()
        app.logger.exception("Could not add batch")

        if getattr(e, "errno", None) == 1062:
            return jsonify({
                "error": "This batch number already exists for this product"
            }), 409

        return jsonify({"error": "Could not add batch"}), 500

    finally:
        cursor.close()
        connection.close()



# Get all batches
@app.route("/api/batches", methods=["GET"])
def get_batches():
    connection = get_connection()
    cursor = connection.cursor(dictionary=True)

    try:
        cursor.execute("""
            SELECT
                b.batch_id,
                b.product_id,
                p.name AS product_name,
                b.batch_number,
                b.quantity,
                b.expiry_date,
                b.created_at
            FROM product_batches b
            JOIN products p ON p.product_id = b.product_id
            ORDER BY b.batch_id DESC
        """)

        batches = cursor.fetchall()

        for batch in batches:
            if batch["expiry_date"]:
                batch["expiry_date"] = batch["expiry_date"].isoformat()
            if batch["created_at"]:
                batch["created_at"] = batch["created_at"].isoformat()

        return jsonify({
            "count": len(batches),
            "batches": batches
        }), 200

    finally:
        cursor.close()
        connection.close()


# Update a batch
@app.route("/api/batches/<int:batch_id>", methods=["PUT"])
def update_batch(batch_id):
    data = request.get_json(silent=True)

    if not isinstance(data, dict) or not data:
        return jsonify({"error": "JSON data is required"}), 400

    allowed_fields = {"batch_number", "quantity", "expiry_date"}

    if not any(field in data for field in allowed_fields):
        return jsonify({"error": "No valid fields provided"}), 400

    updates = []
    values = []

    if "batch_number" in data:
        batch_number = data["batch_number"]

        if not isinstance(batch_number, str) or not batch_number.strip():
            return jsonify({"error": "Invalid batch_number"}), 400

        updates.append("batch_number = %s")
        values.append(batch_number.strip())

    if "quantity" in data:
        try:
            quantity = data["quantity"]

            if isinstance(quantity, bool):
                raise ValueError

            quantity = int(quantity)

            if quantity < 0:
                raise ValueError

        except (ValueError, TypeError):
            return jsonify({"error": "Invalid quantity"}), 400

        updates.append("quantity = %s")
        values.append(quantity)

    if "expiry_date" in data:
        expiry_date = data["expiry_date"]

        if expiry_date in (None, ""):
            expiry_date = None
        else:
            try:
                expiry_date = date.fromisoformat(expiry_date).isoformat()
            except (ValueError, TypeError):
                return jsonify({"error": "Invalid expiry_date; use YYYY-MM-DD"}), 400

        updates.append("expiry_date = %s")
        values.append(expiry_date)

    connection = get_connection()
    cursor = connection.cursor()

    try:
        cursor.execute(
            "SELECT batch_id FROM product_batches WHERE batch_id = %s",
            (batch_id,)
        )

        if cursor.fetchone() is None:
            return jsonify({"error": "Batch not found"}), 404

        values.append(batch_id)

        cursor.execute(
            f"UPDATE product_batches SET {', '.join(updates)} "
            "WHERE batch_id = %s",
            tuple(values)
        )

        connection.commit()

        return jsonify({
            "message": "Batch updated successfully",
            "batch_id": batch_id
        }), 200

    except Exception as e:
        connection.rollback()
        app.logger.exception("Could not update batch")

        if getattr(e, "errno", None) == 1062:
            return jsonify({"error": "Duplicate batch number"}), 409

        return jsonify({"error": "Could not update batch"}), 500

    finally:
        cursor.close()
        connection.close()


# Get batches expiring within the next 30 days,
# including batches that have already expired
@app.route("/api/batches/expiring", methods=["GET"])
def get_expiring_batches():
    connection = get_connection()
    cursor = connection.cursor(dictionary=True)

    try:
        cursor.execute("""
            SELECT
                b.batch_id,
                b.product_id,
                p.name AS product_name,
                b.batch_number,
                b.quantity,
                b.expiry_date
            FROM product_batches b
            JOIN products p ON p.product_id = b.product_id
            WHERE b.expiry_date IS NOT NULL
              AND b.expiry_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)
            ORDER BY b.expiry_date ASC
        """)

        batches = cursor.fetchall()

        for batch in batches:
            if batch["expiry_date"]:
                batch["expiry_date"] = batch["expiry_date"].isoformat()

        return jsonify({
            "count": len(batches),
            "expiring_batches": batches
        }), 200

    finally:
        cursor.close()
        connection.close()


# ---------------- EXPENSES APIs ----------------

from datetime import date


# Add a new expense
@app.route("/api/expenses", methods=["POST"])
def add_expense():
    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({"error": "JSON data is required"}), 400

    title = data.get("title")
    category = data.get("category", "")
    amount = data.get("amount")
    expense_date = data.get("expense_date", date.today().isoformat())
    description = data.get("description", "")

    if not isinstance(title, str) or not title.strip() or amount is None:
        return jsonify({"error": "Title and amount are required"}), 400

    try:
        if isinstance(amount, bool):
            raise ValueError

        amount = float(amount)
        if amount <= 0:
            raise ValueError

        expense_date = date.fromisoformat(expense_date).isoformat()

    except (ValueError, TypeError):
        return jsonify({
            "error": "Amount must be positive and expense_date must use YYYY-MM-DD"
        }), 400

    connection = get_connection()
    cursor = connection.cursor()

    try:
        cursor.execute("""
            INSERT INTO expenses
                (title, category, amount, expense_date, description)
            VALUES (%s, %s, %s, %s, %s)
        """, (
            title.strip(), category, amount, expense_date, description
        ))

        expense_id = cursor.lastrowid
        connection.commit()

        return jsonify({
            "message": "Expense added successfully",
            "expense_id": expense_id
        }), 201

    except Exception:
        connection.rollback()
        app.logger.exception("Could not add expense")
        return jsonify({"error": "Could not add expense"}), 500

    finally:
        cursor.close()
        connection.close()


# Get all expenses
@app.route("/api/expenses", methods=["GET"])
def get_expenses():
    connection = get_connection()
    cursor = connection.cursor(dictionary=True)

    try:
        cursor.execute("""
            SELECT expense_id, title, category, amount,
                   expense_date, description, created_at
            FROM expenses
            ORDER BY expense_date DESC, expense_id DESC
        """)

        expenses = cursor.fetchall()

        for expense in expenses:
            expense["amount"] = float(expense["amount"])
            if expense["expense_date"]:
                expense["expense_date"] = expense["expense_date"].isoformat()
            if expense["created_at"]:
                expense["created_at"] = expense["created_at"].isoformat()

        return jsonify({
            "count": len(expenses),
            "total_expenses": round(
                sum(item["amount"] for item in expenses), 2
            ),
            "expenses": expenses
        }), 200

    finally:
        cursor.close()
        connection.close()


# Update an expense
@app.route("/api/expenses/<int:expense_id>", methods=["PUT"])
def update_expense(expense_id):
    data = request.get_json(silent=True)

    if not isinstance(data, dict) or not data:
        return jsonify({"error": "JSON data is required"}), 400

    allowed = {"title", "category", "amount", "expense_date", "description"}
    if not any(field in data for field in allowed):
        return jsonify({"error": "No valid fields provided"}), 400

    updates = []
    values = []

    for field in ("title", "category", "amount", "expense_date", "description"):
        if field not in data:
            continue

        value = data[field]

        if field == "title":
            if not isinstance(value, str) or not value.strip():
                return jsonify({"error": "Title cannot be empty"}), 400
            value = value.strip()

        elif field == "amount":
            try:
                if isinstance(value, bool):
                    raise ValueError
                value = float(value)
                if value <= 0:
                    raise ValueError
            except (ValueError, TypeError):
                return jsonify({"error": "Amount must be positive"}), 400

        elif field == "expense_date":
            try:
                value = date.fromisoformat(value).isoformat()
            except (ValueError, TypeError):
                return jsonify({
                    "error": "Date must use YYYY-MM-DD"
                }), 400

        updates.append(f"{field} = %s")
        values.append(value)

    connection = get_connection()
    cursor = connection.cursor()

    try:
        cursor.execute(
            "SELECT expense_id FROM expenses WHERE expense_id = %s",
            (expense_id,)
        )

        if cursor.fetchone() is None:
            return jsonify({"error": "Expense not found"}), 404

        values.append(expense_id)

        cursor.execute(
            f"UPDATE expenses SET {', '.join(updates)} "
            "WHERE expense_id = %s",
            tuple(values)
        )

        connection.commit()

        return jsonify({
            "message": "Expense updated successfully",
            "expense_id": expense_id
        }), 200

    except Exception:
        connection.rollback()
        app.logger.exception("Could not update expense")
        return jsonify({"error": "Could not update expense"}), 500

    finally:
        cursor.close()
        connection.close()


# Delete an expense
@app.route("/api/expenses/<int:expense_id>", methods=["DELETE"])
def delete_expense(expense_id):
    connection = get_connection()
    cursor = connection.cursor()

    try:
        cursor.execute(
            "DELETE FROM expenses WHERE expense_id = %s",
            (expense_id,)
        )

        if cursor.rowcount == 0:
            return jsonify({"error": "Expense not found"}), 404

        connection.commit()

        return jsonify({
            "message": "Expense deleted successfully",
            "expense_id": expense_id
        }), 200

    except Exception:
        connection.rollback()
        app.logger.exception("Could not delete expense")
        return jsonify({"error": "Could not delete expense"}), 500

    finally:
        cursor.close()
        connection.close()


# ---------------- PAYMENTS API ----------------




@app.route("/api/payments", methods=["POST"])
def add_payment():
    from decimal import Decimal, InvalidOperation
    from datetime import date

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({"error": "Valid JSON data required"}), 400

    invoice_id = data.get("invoice_id")
    amount = data.get("amount")
    payment_method = data.get("payment_method", "Cash")
    payment_date = data.get("payment_date", date.today().isoformat())
    notes = data.get("notes", "")

    try:
        if isinstance(invoice_id, bool) or isinstance(amount, bool):
            raise ValueError

        invoice_id = int(invoice_id)
        amount = Decimal(str(amount))

        if invoice_id <= 0 or not amount.is_finite() or amount <= 0:
            raise ValueError

        payment_date = date.fromisoformat(payment_date).isoformat()

        if not isinstance(payment_method, str) or not payment_method.strip():
            raise ValueError

        if not isinstance(notes, str):
            raise ValueError

    except (ValueError, TypeError, InvalidOperation):
        return jsonify({
            "error": "Invalid invoice, amount, payment method or date"
        }), 400

    connection = get_connection()
    cursor = connection.cursor(dictionary=True)

    try:
        connection.start_transaction()

        cursor.execute("""
            SELECT invoice_id, total_amount
            FROM invoices
            WHERE invoice_id = %s
            FOR UPDATE
        """, (invoice_id,))

        invoice = cursor.fetchone()

        if invoice is None:
            connection.rollback()
            return jsonify({"error": "Invoice not found"}), 404

        total = Decimal(str(invoice["total_amount"] or 0))

        cursor.execute("""
            SELECT COALESCE(SUM(amount), 0) AS amount_paid
            FROM payments
            WHERE invoice_id = %s
        """, (invoice_id,))

        paid_before = Decimal(str(cursor.fetchone()["amount_paid"] or 0))
        balance = total - paid_before

        if balance <= 0:
            connection.rollback()
            return jsonify({
                "error": "This invoice is already fully paid"
            }), 400

        if amount > balance:
            connection.rollback()
            return jsonify({
                "error": "Payment exceeds the remaining balance",
                "balance_due": float(balance)
            }), 400

        cursor.execute("""
            INSERT INTO payments
                (invoice_id, amount, payment_method, payment_date, notes)
            VALUES (%s, %s, %s, %s, %s)
        """, (
            invoice_id,
            str(amount),
            payment_method.strip(),
            payment_date,
            notes.strip()
        ))

        payment_id = cursor.lastrowid
        total_paid = paid_before + amount
        balance_due = total - total_paid

        if total_paid >= total:
            status = "Paid"
        elif total_paid > 0:
            status = "Partial"
        else:
            status = "Pending"

        cursor.execute("""
            UPDATE invoices
            SET status = %s
            WHERE invoice_id = %s
        """, (status, invoice_id))

        connection.commit()

        return jsonify({
            "message": "Payment recorded successfully",
            "payment_id": payment_id,
            "invoice_id": invoice_id,
            "amount_paid": float(total_paid),
            "balance_due": float(max(balance_due, Decimal("0"))),
            "status": status
        }), 201

    except Exception:
        connection.rollback()
        app.logger.exception("Could not record payment")
        return jsonify({"error": "Could not record payment"}), 500

    finally:
        cursor.close()
        connection.close()


@app.route("/api/payments", methods=["GET"])
def get_payments():
    connection = get_connection()
    cursor = connection.cursor(dictionary=True)

    try:
        cursor.execute("""
            SELECT payment_id, invoice_id, amount,
                   payment_method, payment_date, notes
            FROM payments
            ORDER BY payment_id DESC
        """)

        payments = cursor.fetchall()

        for payment in payments:
            payment["amount"] = float(payment["amount"])
            if payment["payment_date"]:
                payment["payment_date"] = payment["payment_date"].isoformat()

        return jsonify(payments), 200

    except Exception:
        app.logger.exception("Could not fetch payments")
        return jsonify({"error": "Could not fetch payments"}), 500

    finally:
        cursor.close()
        connection.close()


# ---------------- BUSINESS SETTINGS API ----------------

@app.route("/api/business-settings", methods=["GET"])
def get_business_settings():
    connection = get_connection()
    cursor = connection.cursor(dictionary=True)

    try:
        cursor.execute("""
            SELECT setting_id, business_name, address, phone,
                   email, gst_number, currency, updated_at
            FROM business_settings
            ORDER BY setting_id DESC
            LIMIT 1
        """)
        settings = cursor.fetchone()

        if settings is None:
            return jsonify({"message": "Business settings not configured"}), 404

        if settings.get("updated_at"):
            settings["updated_at"] = settings["updated_at"].isoformat()

        return jsonify(settings), 200

    except Exception:
        app.logger.exception("Could not fetch business settings")
        return jsonify({"error": "Could not fetch business settings"}), 500

    finally:
        cursor.close()
        connection.close()


@app.route("/api/business-settings", methods=["POST"])
def save_business_settings():
    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({"error": "Valid JSON data required"}), 400

    business_name = data.get("business_name")
    address = data.get("address", "")
    phone = data.get("phone", "")
    email = data.get("email", "")
    gst_number = data.get("gst_number", "")
    currency = data.get("currency", "INR")

    if not isinstance(business_name, str) or not business_name.strip():
        return jsonify({"error": "business_name is required"}), 400

    connection = get_connection()
    cursor = connection.cursor(dictionary=True)

    try:
        cursor.execute("""
            SELECT setting_id
            FROM business_settings
            ORDER BY setting_id DESC
            LIMIT 1
        """)
        existing = cursor.fetchone()

        if existing:
            cursor.execute("""
                UPDATE business_settings
                SET business_name=%s, address=%s, phone=%s,
                    email=%s, gst_number=%s, currency=%s
                WHERE setting_id=%s
            """, (
                business_name.strip(), address, phone,
                email, gst_number, currency, existing["setting_id"]
            ))
            setting_id = existing["setting_id"]
            message = "Business settings updated successfully"
        else:
            cursor.execute("""
                INSERT INTO business_settings
                (business_name, address, phone, email, gst_number, currency)
                VALUES (%s, %s, %s, %s, %s, %s)
            """, (
                business_name.strip(), address, phone,
                email, gst_number, currency
            ))
            setting_id = cursor.lastrowid
            message = "Business settings saved successfully"

        connection.commit()

        return jsonify({
            "message": message,
            "setting_id": setting_id
        }), 200

    except Exception:
        connection.rollback()
        app.logger.exception("Could not save business settings")
        return jsonify({"error": "Could not save business settings"}), 500

    finally:
        cursor.close()
        connection.close()


# ---------------- RUN APPLICATION ----------------

if __name__ == "__main__":
    create_tables()
    app.run(debug=True)
