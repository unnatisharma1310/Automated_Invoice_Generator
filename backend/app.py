from flask import send_file
from io import BytesIO
from flask import Flask, jsonify, request
from database import get_connection, create_tables

app = Flask(__name__)


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


# Add a new product
@app.route("/api/products", methods=["POST"])
def add_product():
    data = request.get_json(silent=True)

    if not data:
        return jsonify({"error": "JSON data is required"}), 400

    name = data.get("name")
    price = data.get("price")
    stock = data.get("stock_quantity", 0)

    if not name or price is None:
        return jsonify({
            "error": "Name and price are required"
        }), 400

    try:
        price = float(price)
        stock = int(stock)

        if price < 0 or stock < 0:
            return jsonify({
                "error": "Price and stock cannot be negative"
            }), 400

    except (ValueError, TypeError):
        return jsonify({
            "error": "Invalid price or stock"
        }), 400

    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute(
        """
        INSERT INTO products (name, price, stock_quantity)
        VALUES (%s, %s, %s)
        """,
        (name, price, stock)
    )

    connection.commit()
    product_id = cursor.lastrowid

    cursor.close()
    connection.close()

    return jsonify({
        "message": "Product added successfully!",
        "product_id": product_id
    }), 201


# Update an existing product
@app.route("/api/products/<int:product_id>", methods=["PUT"])
def update_product(product_id):
    data = request.get_json(silent=True)

    if not isinstance(data, dict) or not data:
        return jsonify({"error": "JSON data is required"}), 400

    allowed_fields = {
        "name", "price", "stock_quantity", "minimum_stock"
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

    for field in ("price", "stock_quantity", "minimum_stock"):
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


# ---------------- INVOICE GENERATION API ----------------

@app.route("/api/invoices", methods=["POST"])
def create_invoice():
    data = request.get_json(silent=True) or {}

    customer_id = data.get("customer_id")
    items = data.get("items")

    if customer_id is None or not isinstance(items, list) or not items:
        return jsonify({
            "error": "Customer ID and invoice items are required"
        }), 400

    try:
        customer_id = int(customer_id)

        if customer_id <= 0:
            raise ValueError()

        # Validate all items before changing the database
        validated_items = []
        for item in items:
            product_id = int(item["product_id"])
            quantity = int(item["quantity"])

            if product_id <= 0 or quantity <= 0:
                raise ValueError()

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

        # Create invoice record
        cursor.execute(
            """
            INSERT INTO invoices (customer_id, total_amount)
            VALUES (%s, 0)
            """,
            (customer_id,)
        )
        invoice_id = cursor.lastrowid
        total_amount = 0

        for product_id, quantity in validated_items:
            cursor.execute(
                """
                SELECT product_id, name, price, stock_quantity
                FROM products
                WHERE product_id = %s
                FOR UPDATE
                """,
                (product_id,)
            )
            product = cursor.fetchone()

            if product is None:
                connection.rollback()
                return jsonify({
                    "error": f"Product ID {product_id} not found"
                }), 404

            if product["stock_quantity"] < quantity:
                connection.rollback()
                return jsonify({
                    "error": f"Insufficient stock for {product['name']}"
                }), 400

            unit_price = float(product["price"])
            line_total = round(unit_price * quantity, 2)
            total_amount += line_total

            cursor.execute(
                """
                INSERT INTO invoice_items
                (invoice_id, product_id, quantity, unit_price, line_total)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (invoice_id, product_id, quantity,
                 unit_price, line_total)
            )

            
            # Save stock before and after the sale
            previous_stock = product["stock_quantity"]
            new_stock = previous_stock - quantity

            # Reduce product stock
            cursor.execute(
                """
                UPDATE products
                SET stock_quantity = stock_quantity - %s
                WHERE product_id = %s
                """,
                (quantity, product_id)
            )

            # Record stock change in history
            cursor.execute(
                """
                INSERT INTO stock_history
                (
                    product_id,
                    change_type,
                    quantity_changed,
                    previous_stock,
                    new_stock,
                    note
                )
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                (
                    product_id,
                    "SALE",
                    quantity,
                    previous_stock,
                    new_stock,
                    f"Stock reduced for invoice #{invoice_id}"
                )
            )


        total_amount = round(total_amount, 2)

        cursor.execute(
            """
            UPDATE invoices
            SET total_amount = %s
            WHERE invoice_id = %s
            """,
            (total_amount, invoice_id)
        )

        connection.commit()

        return jsonify({
            "message": "Invoice created successfully!",
            "invoice_id": invoice_id,
            "customer_id": customer_id,
            "total_amount": total_amount
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


# Get invoice history
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
                i.total_amount
            FROM invoices i
            JOIN customers c
                ON i.customer_id = c.customer_id
            ORDER BY i.invoice_id DESC
        """)

        invoices = cursor.fetchall()

        for invoice in invoices:
            if invoice["invoice_date"]:
                invoice["invoice_date"] = (
                    invoice["invoice_date"].isoformat()
                )
            invoice["total_amount"] = float(invoice["total_amount"])

        return jsonify(invoices)

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

        story.append(Paragraph(
            "AUTOMATED INVOICE GENERATOR",
            styles["Title"]
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

        story.append(Paragraph(
            f"<b>Grand Total: Rs. {float(invoice['total_amount']):.2f}</b>",
            styles["Heading2"]
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
                COUNT(*) AS total_invoices
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


# ---------------- RUN APPLICATION ----------------

if __name__ == "__main__":
    create_tables()
    app.run(debug=True)
