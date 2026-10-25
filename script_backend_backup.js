(() => {
"use strict";

const $ = id => document.getElementById(id);
const API_BASE = "http://127.0.0.1:5000/api";

function on(id, eventName, handler) {
  const el = $(id);
  if (el) el.addEventListener(eventName, handler);
}

const money = value =>
  "₹" + Number(value || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
};

function loadData(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function safe(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function notify(message) {
  const toast = $("toast");

  if (!toast) {
    console.log(message);
    return;
  }

  toast.textContent = message;
  toast.style.display = "block";

  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => {
    toast.style.display = "none";
  }, 3000);
}

async function fetchProductsFromBackend() {
  const response = await fetch(`${API_BASE}/products`);

  if (!response.ok) {
    throw new Error("Products API failed: " + response.status);
  }

  const data = await response.json();

  return data.map(p => ({
    id: Number(p.product_id),
    name: p.name,
    sku: `SKU-${p.product_id}`,
    price: Number(p.price),
    stock: Number(p.stock_quantity || 0),
    threshold: Number(p.minimum_stock || 0),
    gst: 0,

    // Backend mein batch table abhi confirm nahi hai,
    // isliye filhaal ek legacy batch banega.
    batches: [{
      id: `legacy-${p.product_id}`,
      number: `LEGACY-SKU-${p.product_id}`,
      stock: Number(p.stock_quantity || 0),
      expiryDate: ""
    }]
  }));
}


async function fetchInvoicesFromBackend() {
  const response = await fetch(`${API_BASE}/invoices`);

  if (!response.ok) {
    throw new Error("Invoices could not be loaded.");
  }

  const data = await response.json();

  return data.map(inv => ({
    id: `INV-${inv.invoice_id}`,
    customer: inv.customer_name,
    customerId: inv.customer_id,
    date: inv.invoice_date,
    status: "Pending",
    total: Number(inv.total_amount),
    subtotal: Number(inv.total_amount),
    discount: 0,
    tax: 0,
    quantity: 0,
    productName: "Invoice details",
    items: []
  }));
}

/* ---------- PRODUCT DATA AND MIGRATION ---------- */

function normalizeProducts(input) {
  let changed = false;

  const normalized = (Array.isArray(input) ? input : []).map((p, index) => {
    const product = { ...p };

    product.id = Number(product.id) || Date.now() + index;
    product.name = String(product.name || "Unnamed product");
    product.sku = String(product.sku || `SKU-${product.id}`);
    product.price = Math.max(0, Number(product.price) || 0);
    product.threshold = Math.max(0, Number(product.threshold) || 0);
    product.gst = Math.max(0, Number(product.gst) || 0);

    if (!Array.isArray(product.batches)) {
      changed = true;

      product.batches = [{
        id: `legacy-${product.id}`,
        number: `LEGACY-${product.sku}`,
        stock: Math.max(0, Number(product.stock) || 0),
        expiryDate: ""
      }];
    } else {
      product.batches = product.batches.map((b, i) => ({
        id: String(b.id ?? `${product.id}-${i}`),
        number: String(b.number || `BATCH-${i+1}`),
        stock: Math.max(0, Number(b.stock) || 0),
        expiryDate: String(b.expiryDate || "")
      }));
    }

    product.stock = product.batches.reduce(
      (sum, b) => sum + b.stock, 0
    );

    return product;
  });

  return { products: normalized, changed };
}

const rawProducts = loadData("invoice_products", [
  { id: 1, name: "Notebook", sku: "SKU-101", price: 80, stock: 100, threshold: 10, gst: 12 },
  { id: 2, name: "Pen", sku: "SKU-102", price: 20, stock: 50, threshold: 10, gst: 5 },
  { id: 3, name: "Office Bag", sku: "SKU-103", price: 650, stock: 25, threshold: 5, gst: 18 },
  { id: 4, name: "Calculator", sku: "SKU-104", price: 450, stock: 0, threshold: 5, gst: 18 }
]);

const migration = normalizeProducts(rawProducts);

let products = migration.products;
let invoices = loadData("invoice_history", []);
let nextInvoiceId = Math.max(
  1001,
  Number(localStorage.getItem("invoice_next_id")) || 1001
);

let currentInvoice = null;

if (migration.changed) {
  localStorage.setItem("invoice_products", JSON.stringify(products));
}

function saveData() {
  localStorage.setItem("invoice_products", JSON.stringify(products));
  localStorage.setItem("invoice_history", JSON.stringify(invoices));
  localStorage.setItem("invoice_next_id", String(nextInvoiceId));
}

function totalStock(product) {
  return product.batches.reduce(
    (sum, batch) => sum + Number(batch.stock || 0), 0
  );
}

/* ---------- EXPIRY TRACKING ---------- */

function expiryInfo(batch) {
  if (!batch.expiryDate) {
    return { label: "Set expiry date", cls: "no-date", days: null };
  }

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const target = new Date(`${batch.expiryDate}T00:00:00`);

  if (Number.isNaN(target.getTime())) {
    return { label: "Invalid date", cls: "no-date", days: null };
  }

  const days = Math.ceil(
    (target.getTime() - now.getTime()) / 86400000
  );

  if (days < 0) {
    return { label: "Expired", cls: "expired", days };
  }

  if (days <= 30) {
    return {
      label: days === 0 ? "Expires today" : `Expires in ${days} day(s)`,
      cls: "soon",
      days
    };
  }

  return { label: "Valid", cls: "", days };
}


function batchSellable(batch) {
  const info = expiryInfo(batch);

  return (
    Number(batch.stock) > 0 &&
    (
      !batch.expiryDate ||
      (info.days !== null && info.days >= 0)
    )
  );
}


/* ---------- NAVIGATION ---------- */

function showPage(page) {
  document.querySelectorAll(".page").forEach(section => {
    section.classList.toggle("active", section.id === page);
  });

  document.querySelectorAll(".nav").forEach(button => {
    button.classList.toggle("active", button.dataset.page === page);
  });

  const titles = {
    dashboard: "Dashboard",
    create: "Create Invoice",
    invoices: "Invoice History",
    inventory: "Inventory Management",
    analytics: "Sales Analytics"
  };

  if ($("pageTitle")) {
    $("pageTitle").textContent = titles[page] || "Dashboard";
  }

  renderAll();
}

document.querySelectorAll(".nav").forEach(button => {
  button.addEventListener("click", () => showPage(button.dataset.page));
});

document.querySelectorAll("[data-go]").forEach(button => {
  button.addEventListener("click", () => showPage(button.dataset.go));
});

on("newInvoiceBtn", "click", newInvoice);

/* ---------- CREATE INVOICE ---------- */

function newInvoice() {
  currentInvoice = null;

  if ($("invoiceForm")) $("invoiceForm").reset();

  if ($("date")) $("date").value = todayISO();
  if ($("status")) $("status").value = "Pending";
  if ($("discount")) $("discount").value = 0;
  if ($("quantity")) $("quantity").value = 1;

  if ($("invoiceNumber")) {
    $("invoiceNumber").textContent = "INV-" + nextInvoiceId;
  }

  if ($("invoiceDateLabel") && $("date")) {
    $("invoiceDateLabel").textContent = $("date").value;
  }

  populateProductOptions();
  showPage("create");
  calculateInvoice();
}

function selectedPair() {
  const value = $("product")?.value || "";
  const parts = value.split("|");

  return parts.length === 2
    ? { productId: Number(parts[0]), batchId: parts[1] }
    : null;
}

function populateProductOptions() {
  const select = $("product");
  if (!select) return;

  const previous = select.value;

  select.innerHTML =
    '<option value="">Select a valid product batch</option>';

  products.forEach(product => {
    product.batches.forEach(batch => {
      if (!batchSellable(batch)) return;

      const option = document.createElement("option");

      option.value = `${product.id}|${batch.id}`;
      option.textContent =
        `${product.name} — ${batch.number} — ${money(product.price)} — Stock: ${batch.stock} — Exp: ${batch.expiryDate}`;

      select.appendChild(option);
    });
  });

  if ([...select.options].some(option => option.value === previous)) {
    select.value = previous;
  }

  updateSelectedProduct();

  if ($("batchHint")) {
    $("batchHint").textContent =
      "Expired batches, batches without an expiry date, and zero-stock batches cannot be selected.";
  }
}

function updateSelectedProduct() {
  const pair = selectedPair();

  const product = pair
    ? products.find(p => p.id === pair.productId)
    : null;

  const batch = pair && product
    ? product.batches.find(b => String(b.id) === String(pair.batchId))
    : null;

  if (product && batch && batchSellable(batch)) {
    if ($("price")) $("price").value = product.price;
    if ($("gst")) $("gst").value = product.gst;

    if ($("quantity")) {
      $("quantity").max = batch.stock;
      $("quantity").value = Math.min(
        Number($("quantity").value) || 1,
        batch.stock
      );
    }
  } else {
    if ($("price")) $("price").value = "";

    if ($("quantity")) {
      $("quantity").removeAttribute("max");
    }
  }

  calculateInvoice();
}

function calculateInvoice() {
  const quantity = Math.max(0, Number($("quantity")?.value) || 0);
  const price = Math.max(0, Number($("price")?.value) || 0);

  const discountRate = Math.min(
    100,
    Math.max(0, Number($("discount")?.value) || 0)
  );

  const gstRate = Math.max(0, Number($("gst")?.value) || 0);

  const subtotal = quantity * price;
  const discount = subtotal * discountRate / 100;
  const taxableAmount = subtotal - discount;
  const tax = taxableAmount * gstRate / 100;
  const total = taxableAmount + tax;

  if ($("subtotal")) $("subtotal").textContent = money(subtotal);
  if ($("discountAmount")) $("discountAmount").textContent = money(discount);
  if ($("taxAmount")) $("taxAmount").textContent = money(tax);
  if ($("grandTotal")) $("grandTotal").textContent = money(total);

  return { quantity, price, subtotal, discount, tax, total };
}

["quantity", "price", "discount", "gst"].forEach(id => {
  on(id, "input", calculateInvoice);
  on(id, "change", calculateInvoice);
});

on("product", "change", updateSelectedProduct);

on("date", "change", () => {
  if ($("invoiceDateLabel") && $("date")) {
    $("invoiceDateLabel").textContent = $("date").value;
  }
});


/* SAVE INVOICE - BACKEND CONNECTED */

on("invoiceForm", "submit", async event => {
  event.preventDefault();

  const customer = $("customer")?.value.trim() || "";
  const email = $("email")?.value.trim() || "";
  const pair = selectedPair();

  const product = pair
    ? products.find(p => p.id === pair.productId)
    : null;

  const batch = pair && product
    ? product.batches.find(
        b => String(b.id) === String(pair.batchId)
      )
    : null;

  const calculation = calculateInvoice();

  if (!customer || !product || !batch) {
    return notify(
      "Please enter customer details and select a product batch."
    );
  }

  if (!batchSellable(batch)) {
    return notify(
      "This batch is expired, has no expiry date, or has no stock."
    );
  }

  if (
    !Number.isInteger(calculation.quantity) ||
    calculation.quantity < 1 ||
    calculation.quantity > batch.stock
  ) {
    return notify(
      "Enter a valid quantity within available batch stock."
    );
  }

  const discountRate = Number($("discount")?.value) || 0;

  if (
    calculation.price < 0 ||
    discountRate < 0 ||
    discountRate > 100
  ) {
    return notify("Please check the price and discount.");
  }

  try {
    // 1. Customer ko database mein save karo
    const customerResponse = await fetch(
      `${API_BASE}/customers`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name: customer,
          email: email,
          phone: "",
          address: ""
        })
      }
    );

    const customerResult = await customerResponse.json();

    if (!customerResponse.ok) {
      throw new Error(
        customerResult.error || "Customer save failed."
      );
    }

    const customerId = Number(customerResult.customer_id);

    if (!customerId) {
      throw new Error("Customer ID was not returned by backend.");
    }

    // 2. Invoice backend ko bhejo
    const invoiceResponse = await fetch(
      `${API_BASE}/invoices`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          customer_id: customerId,
          items: [
            {
              product_id: product.id,
              quantity: calculation.quantity
            }
          ]
        })
      }
    );

    const invoiceResult = await invoiceResponse.json();

    if (!invoiceResponse.ok) {
      throw new Error(
        invoiceResult.error || "Invoice creation failed."
      );
    }

    // 3. Backend se latest products/stock reload karo
    products = await fetchProductsFromBackend();

    // 4. Invoice ko frontend display ke liye prepare karo
    const invoice = {
      id: "INV-" + invoiceResult.invoice_id,
      customer: customer,
      email: email,
      date: $("date")?.value || todayISO(),
      status: $("status")?.value || "Pending",
      productId: product.id,
      productName: product.name,
      sku: product.sku,
      batchId: batch.id,
      batchNumber: batch.number,
      batchExpiry: batch.expiryDate,
      quantity: calculation.quantity,
      price: calculation.price,
      subtotal: calculation.subtotal,
      discount: calculation.discount,
      tax: calculation.tax,
      gst: Number($("gst")?.value) || 0,

      // Backend total is authoritative for the saved invoice
      total: Number(invoiceResult.total_amount)
    };

    invoices.unshift(invoice);
    currentInvoice = invoice;
    nextInvoiceId++;

    saveData();
    renderAll();

    if ($("invoiceNumber")) {
      $("invoiceNumber").textContent = invoice.id;
    }

    notify(
      `Invoice ${invoice.id} saved to database successfully!`
    );

    console.log("Invoice created:", invoiceResult);

  } catch (error) {
    console.error("Invoice save failed:", error);

    notify(
      error.message || "Invoice save failed. Check backend."
    );
  }
});

/* CLEAR FORM */

on("clearBtn", "click", () => {
  setTimeout(() => {
    currentInvoice = null;

    if ($("invoiceForm")) $("invoiceForm").reset();

    if ($("date")) $("date").value = todayISO();
    if ($("invoiceDateLabel") && $("date")) {
      $("invoiceDateLabel").textContent = $("date").value;
    }

    if ($("invoiceNumber")) {
      $("invoiceNumber").textContent = "INV-" + nextInvoiceId;
    }

    if ($("status")) $("status").value = "Pending";
    if ($("discount")) $("discount").value = 0;
    if ($("quantity")) $("quantity").value = 1;

    populateProductOptions();
    calculateInvoice();
  }, 0);
});

/* ---------- PRINT / SAVE PDF IN SELECTED LANGUAGE ---------- */

on("printBtn", "click", () => {
  const customer = $("customer")?.value.trim() || "";
  const pair = selectedPair();

  const product = pair
    ? products.find(p => p.id === pair.productId)
    : null;

  const batch = pair && product
    ? product.batches.find(b => String(b.id) === String(pair.batchId))
    : null;

  if (!customer || !product || !batch) {
    return notify("Enter customer details and select a product batch first.");
  }

  if (!batchSellable(batch)) {
    return notify("This batch cannot be invoiced because it is expired or unavailable.");
  }

  const calc = calculateInvoice();

  if (
    !Number.isInteger(calc.quantity) ||
    calc.quantity < 1 ||
    calc.quantity > batch.stock
  ) {
    return notify("Enter a valid quantity within available batch stock.");
  }

  const invoice = {
    id: currentInvoice?.id || "INV-" + nextInvoiceId,
    customer,
    email: $("email")?.value.trim() || "",
    date: $("date")?.value || todayISO(),
    status: $("status")?.value || "Pending",
    productName: product.name,
    sku: product.sku,
    batchNumber: batch.number,
    batchExpiry: batch.expiryDate,
    quantity: calc.quantity,
    price: calc.price,
    subtotal: calc.subtotal,
    discount: calc.discount,
    tax: calc.tax,
    gst: Number($("gst")?.value) || 0,
    total: calc.total
  };

  printInvoice(invoice, $("pdfLanguage")?.value || "en");
});

/* ---------- DASHBOARD ---------- */

function renderDashboard() {
  const revenue = invoices.reduce(
    (sum, invoice) => sum + Number(invoice.total || 0), 0
  );

  const lowStock = products.filter(
    product => totalStock(product) <= product.threshold
  ).length;

  if ($("revenue")) $("revenue").textContent = money(revenue);
  if ($("invoiceCount")) $("invoiceCount").textContent = invoices.length;
  if ($("productCount")) $("productCount").textContent = products.length;
  if ($("lowStock")) $("lowStock").textContent = lowStock;

  if ($("recentTable")) {
    $("recentTable").innerHTML = invoices.slice(0, 5).map(invoice => `
      <tr>
        <td>${safe(invoice.id)}</td>
        <td>${safe(invoice.customer)}</td>
        <td>${safe(invoice.date)}</td>
        <td>${money(invoice.total)}</td>
        <td>
          <span class="status ${invoice.status === "Pending" ? "pending" : ""}">
            ${safe(invoice.status)}
          </span>
        </td>
      </tr>
    `).join("") ||
      '<tr><td colspan="5" class="empty">No invoices yet. Create your first invoice.</td></tr>';
  }

  renderExpiryAlerts();
}

function renderExpiryAlerts() {
  if (!$("expiryAlertTable")) return;

  const rows = [];

  products.forEach(product => {
    product.batches.forEach(batch => {
      const info = expiryInfo(batch);

      if (
        batch.expiryDate &&
        info.days !== null &&
        info.days <= 30 &&
        batch.stock > 0
      ) {
        rows.push({ product, batch, info });
      }
    });
  });

  rows.sort((a, b) => a.info.days - b.info.days);

  $("expiryAlertTable").innerHTML = rows.map(({ product, batch, info }) => `
    <tr>
      <td>${safe(product.name)}</td>
      <td>${safe(batch.number)}</td>
      <td>${safe(batch.expiryDate)}</td>
      <td>${batch.stock}</td>
      <td><span class="status ${info.cls}">${safe(info.label)}</span></td>
    </tr>
  `).join("") ||
    '<tr><td colspan="5" class="empty">No expiry alerts. Add expiry dates to your batches.</td></tr>';
}

/* ---------- INVOICE HISTORY ---------- */


function renderInvoices() {
  const query = ($("invoiceSearch")?.value || "").toLowerCase();

  const filtered = invoices.filter(invoice =>
    String(invoice.id).toLowerCase().includes(query) ||
    String(invoice.customer).toLowerCase().includes(query) ||
    String(invoice.productName || "").toLowerCase().includes(query)
  );

  if (!$("invoiceTable")) return;

  $("invoiceTable").innerHTML = filtered.map(invoice => `
    <tr>
      <td>${safe(invoice.id)}</td>
      <td>${safe(invoice.customer)}</td>
      <td>${safe(invoice.date)}</td>
      <td>${safe(invoice.productName || "Details unavailable")}</td>
      <td>${safe(invoice.batchNumber || "—")}</td>
      <td>${money(invoice.total)}</td>
      <td>
        <span class="status ${invoice.status === "Pending" ? "pending" : ""}">
          ${safe(invoice.status || "Unknown")}
        </span>
      </td>
      <td>
        <button class="btn secondary small-btn"
          data-print="${safe(invoice.id)}">Print</button>
        <button class="btn secondary small-btn"
          data-status="${safe(invoice.id)}">Change Status</button>
      </td>
    </tr>
  `).join("") ||
    '<tr><td colspan="8" class="empty">No matching invoices found.</td></tr>';
}


on("invoiceTable", "click", event => {
  const printButton = event.target.closest("[data-print]");
  const statusButton = event.target.closest("[data-status]");

  if (printButton) {
    const invoice = invoices.find(
      item => item.id === printButton.dataset.print
    );

    if (invoice) printSavedInvoice(invoice);
  }

  if (statusButton) {
    const invoice = invoices.find(
      item => item.id === statusButton.dataset.status
    );

    if (!invoice) return;

    invoice.status = invoice.status === "Paid" ? "Pending" : "Paid";

    saveData();
    renderAll();
    notify("Payment status updated.");
  }
});

function printSavedInvoice(invoice) {
  printInvoice(invoice, $("pdfLanguage")?.value || "en");
}

/* ---------- BILINGUAL PDF TEMPLATE ---------- */

function printInvoice(invoice, language) {
  const paper = $("invoicePaper");

  if (!paper) {
    return notify("Invoice print area was not found in HTML.");
  }

  const previous = paper.innerHTML;
  const previousLang = document.documentElement.lang || "en";
  const hindi = language === "hi";

  const t = hindi ? {
    invoice: "चालान",
    business: "InvoicePro व्यवसाय समाधान",
    billTo: "ग्राहक का नाम",
    email: "ईमेल",
    date: "चालान की तारीख",
    product: "उत्पाद",
    batch: "बैच नंबर",
    expiry: "समाप्ति तिथि",
    quantity: "मात्रा",
    unitPrice: "प्रति इकाई मूल्य",
    amount: "राशि",
    subtotal: "उप-योग",
    discount: "छूट",
    gst: "जीएसटी",
    total: "कुल राशि",
    status: "भुगतान की स्थिति",
    paid: "भुगतान हो गया",
    pending: "भुगतान बाकी",
    thanks: "हमारे साथ व्यवसाय करने के लिए धन्यवाद!"
  } : {
    invoice: "INVOICE",
    business: "InvoicePro Business Solutions",
    billTo: "Bill To",
    email: "Email",
    date: "Invoice Date",
    product: "Product",
    batch: "Batch Number",
    expiry: "Expiry Date",
    quantity: "Quantity",
    unitPrice: "Unit Price",
    amount: "Amount",
    subtotal: "Subtotal",
    discount: "Discount",
    gst: "GST",
    total: "Grand Total",
    status: "Payment Status",
    paid: "Paid",
    pending: "Pending",
    thanks: "Thank you for your business!"
  };

  const statusLabel =
    invoice.status === "Paid" ? t.paid : t.pending;

  const emailLine = invoice.email
    ? `<p>${safe(t.email)}: ${safe(invoice.email)}</p>`
    : "";

  paper.innerHTML = `
    <div class="print-invoice" lang="${hindi ? "hi" : "en"}">
      <div class="invoice-header">
        <div>
          <h2>${safe(t.invoice)}</h2>
          <p>${safe(t.business)}</p>
        </div>
        <div class="invoice-number">
          <strong>${safe(invoice.id)}</strong>
          <p>${safe(t.date)}: ${safe(invoice.date)}</p>
        </div>
      </div>

      <h3>${safe(t.billTo)}: ${safe(invoice.customer)}</h3>
      ${emailLine}

      <table>
        <thead>
          <tr>
            <th>${safe(t.product)}</th>
            <th>${safe(t.batch)}</th>
            <th>${safe(t.quantity)}</th>
            <th>${safe(t.unitPrice)}</th>
            <th>${safe(t.amount)}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>${safe(invoice.productName || "Product")}</td>
            <td>${safe(invoice.batchNumber || "Legacy")}</td>
            <td>${Number(invoice.quantity) || 0}</td>
            <td>${money(invoice.price)}</td>
            <td>${money(invoice.subtotal)}</td>
          </tr>
        </tbody>
      </table>

      ${invoice.batchExpiry
        ? `<p>${safe(t.expiry)}: ${safe(invoice.batchExpiry)}</p>`
        : ""}

      <div class="totals">
        <div>
          <span>${safe(t.subtotal)}</span>
          <strong>${money(invoice.subtotal)}</strong>
        </div>
        <div>
          <span>${safe(t.discount)}</span>
          <strong>${money(invoice.discount)}</strong>
        </div>
        <div>
          <span>${safe(t.gst)} (${Number(invoice.gst) || 0}%)</span>
          <strong>${money(invoice.tax)}</strong>
        </div>
        <div class="grand-total">
          <span>${safe(t.total)}</span>
          <strong>${money(invoice.total)}</strong>
        </div>
      </div>

      <p><strong>${safe(t.status)}: ${safe(statusLabel)}</strong></p>
      <p>${safe(t.thanks)}</p>
    </div>
  `;

  document.documentElement.lang = hindi ? "hi" : "en";

  let restored = false;

  function restoreInvoice() {
    if (restored) return;
    restored = true;

    paper.innerHTML = previous;
    document.documentElement.lang = previousLang;

    window.removeEventListener("afterprint", restoreInvoice);
  }

  window.addEventListener("afterprint", restoreInvoice);

  window.print();

  setTimeout(restoreInvoice, 1500);
}

/* ---------- INVENTORY ---------- */

function renderInventory() {
  const query = ($("productSearch")?.value || "").toLowerCase();
  const rows = [];

  products.forEach(product => {
    product.batches.forEach(batch => {
      if (
        product.name.toLowerCase().includes(query) ||
        product.sku.toLowerCase().includes(query) ||
        batch.number.toLowerCase().includes(query)
      ) {
        rows.push({ product, batch });
      }
    });
  });

  if ($("productTable")) {
    $("productTable").innerHTML = rows.map(({ product, batch }) => {
      const info = expiryInfo(batch);

      return `
        <tr>
          <td>${safe(product.name)}</td>
          <td>${safe(product.sku)}</td>
          <td>${safe(batch.number)}</td>
          <td>${money(product.price)}</td>
          <td>${batch.stock}</td>
          <td>${batch.expiryDate ? safe(batch.expiryDate) : "Not set"}</td>
          <td><span class="status ${info.cls}">${safe(info.label)}</span></td>
          <td>
            <button class="btn secondary small-btn"
              data-restock="${safe(product.id)}"
              data-batch="${safe(batch.id)}">Restock</button>
            <button class="btn secondary small-btn"
              data-edit-expiry="${safe(product.id)}"
              data-batch="${safe(batch.id)}">Set Expiry</button>
            <button class="danger-btn small-btn"
              data-delete-batch="${safe(product.id)}"
              data-batch="${safe(batch.id)}">Delete Batch</button>
          </td>
        </tr>
      `;
    }).join("") ||
      '<tr><td colspan="8" class="empty">No matching products or batches found.</td></tr>';
  }

  const select = $("batchProduct");

  if (select) {
    const previous = select.value;
    select.innerHTML = '<option value="">Select product</option>';

    products.forEach(product => {
      const option = document.createElement("option");
      option.value = String(product.id);
      option.textContent = `${product.name} (${product.sku})`;
      select.appendChild(option);
    });

    if ([...select.options].some(option => option.value === previous)) {
      select.value = previous;
    }
  }
}


/* ADD NEW PRODUCT — CONNECTED TO BACKEND */

on("productForm", "submit", async event => {
  event.preventDefault();

  const name = $("productName")?.value.trim() || "";
  const sku = $("sku")?.value.trim() || "";
  const price = Number($("productPrice")?.value);
  const stock = Number($("stock")?.value);
  const threshold = Number($("threshold")?.value || 0);

  if (!name) {
    return notify("Please enter product name.");
  }

  if (
    !Number.isFinite(price) ||
    price < 0 ||
    !Number.isInteger(stock) ||
    stock < 0 ||
    !Number.isInteger(threshold) ||
    threshold < 0
  ) {
    return notify("Please check price, stock and threshold.");
  }

  try {
    const response = await fetch(`${API_BASE}/products`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: name,
        price: price,
        stock_quantity: stock,
        minimum_stock: threshold
      })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        result.error || result.message || "Could not save product."
      );
    }

    // Reload products from the backend after saving.
    products = await fetchProductsFromBackend();

    saveData();
    event.target.reset();

    if ($("threshold")) $("threshold").value = 5;

    renderAll();
    notify("Product saved to database successfully!");

    console.log("Product saved by backend:", result);
  } catch (error) {
    console.error("Add product failed:", error);
    notify("Product save failed. Check Console and backend.");
  }
});


/* ADD BATCH TO EXISTING PRODUCT */

on("batchForm", "submit", event => {
  event.preventDefault();

  const product = products.find(
    p => p.id === Number($("batchProduct")?.value)
  );

  const number = $("newBatchNumber")?.value.trim() || "";
  const stock = Number($("newBatchStock")?.value);
  const expiryDate = $("newBatchExpiry")?.value || "";

  if (!product) return notify("Select a product first.");

  if (
  !number ||
  !Number.isInteger(stock) ||
  stock < 1
) {
  return notify("Enter a batch number and positive stock.");
}

  if (products.some(p =>
    p.batches.some(b => b.number.toLowerCase() === number.toLowerCase())
  )) {
    return notify("This batch number already exists.");
  }

  product.batches.push({
    id: `b-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
    number,
    stock,
    expiryDate
  });

  product.stock = totalStock(product);

  saveData();
  event.target.reset();
  renderAll();
  notify("New batch added successfully.");
});

/* RESTOCK, SET EXPIRY, DELETE BATCH */

on("productTable", "click", event => {
  const restock = event.target.closest("[data-restock]");
  const editExpiry = event.target.closest("[data-edit-expiry]");
  const deleteBatch = event.target.closest("[data-delete-batch]");

  if (restock) {
    const product = products.find(
      p => p.id === Number(restock.dataset.restock)
    );

    const batch = product?.batches.find(
      b => String(b.id) === restock.dataset.batch
    );

    if (!product || !batch) return;

    const input = prompt(`Enter quantity to add to ${batch.number}:`, "10");

    if (input === null || input.trim() === "") return;

    const amount = Number(input);

    if (!Number.isInteger(amount) || amount <= 0) {
      return notify("Enter a positive whole number.");
    }

    batch.stock += amount;
    product.stock = totalStock(product);

    saveData();
    renderAll();
    notify("Batch stock updated.");
  }

  if (editExpiry) {
    const product = products.find(
      p => p.id === Number(editExpiry.dataset.editExpiry)
    );

    const batch = product?.batches.find(
      b => String(b.id) === editExpiry.dataset.batch
    );

    if (!product || !batch) return;

    const input = prompt(
      "Enter expiry date as YYYY-MM-DD:",
      batch.expiryDate || ""
    );

    if (input === null) return;

    if (input && !/^\d{4}-\d{2}-\d{2}$/.test(input)) {
      return notify("Use date format YYYY-MM-DD.");
    }

    batch.expiryDate = input;

    saveData();
    renderAll();
    notify(input ? "Expiry date updated." : "Expiry date cleared.");
  }

  if (deleteBatch) {
    const product = products.find(
      p => p.id === Number(deleteBatch.dataset.deleteBatch)
    );

    const batch = product?.batches.find(
      b => String(b.id) === deleteBatch.dataset.batch
    );

    if (!product || !batch) return;

    if (!confirm(`Delete batch ${batch.number} of ${product.name}? Past invoices will be kept.`)) {
      return;
    }

    product.batches = product.batches.filter(
      b => String(b.id) !== String(batch.id)
    );

    product.stock = totalStock(product);

    if (product.batches.length === 0) {
      products = products.filter(p => p.id !== product.id);
    }

    saveData();
    renderAll();
    notify("Batch removed from inventory.");
  }
});

/* ---------- ANALYTICS ---------- */

function currentMonthKey() {
  return todayISO().slice(0, 7);
}

function productSalesFor(invoiceList) {
  const map = {};

  invoiceList.forEach(invoice => {
    const key = String(invoice.productId ?? invoice.productName);

    if (!map[key]) {
      map[key] = {
        name: invoice.productName || "Product",
        quantity: 0,
        revenue: 0
      };
    }

    map[key].quantity += Number(invoice.quantity || 0);
    map[key].revenue += Number(invoice.total || 0);
  });

  return Object.values(map);
}

function renderBarList(containerId, items, valueKey, formatter, emptyText) {
  const el = $(containerId);
  if (!el) return;

  if (!items.length) {
    el.innerHTML = `<p>${safe(emptyText)}</p>`;
    return;
  }

  const max = Math.max(1, ...items.map(item => item[valueKey]));

  el.innerHTML = items.map(item => `
    <div class="bar-row">
      <div class="bar-info">
        <span>${safe(item.name)}</span>
        <strong>${safe(formatter(item[valueKey]))}</strong>
      </div>
      <div class="bar">
        <div class="bar-fill" style="width:${Math.max(0, item[valueKey]) / max * 100}%"></div>
      </div>
    </div>
  `).join("");
}

function renderAnalytics() {
  const revenue = invoices.reduce(
    (sum, invoice) => sum + Number(invoice.total || 0), 0
  );

  if ($("aRevenue")) $("aRevenue").textContent = money(revenue);

  if ($("aPaid")) {
    $("aPaid").textContent =
      invoices.filter(invoice => invoice.status === "Paid").length;
  }

  if ($("aPending")) {
    $("aPending").textContent =
      invoices.filter(invoice => invoice.status === "Pending").length;
  }

  if ($("aInventory")) {
    $("aInventory").textContent = money(
      products.reduce(
        (sum, product) => sum + product.price * totalStock(product), 0
      )
    );
  }

  const monthly = {};

  invoices.forEach(invoice => {
    const month = (invoice.date || "").slice(0, 7) || "Unknown";
    monthly[month] = (monthly[month] || 0) + Number(invoice.total || 0);
  });

  const months = Object.entries(monthly)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-6);

  const maxRevenue = Math.max(1, ...months.map(item => item[1]));

  if ($("monthlyChart")) {
    $("monthlyChart").innerHTML = months.map(([month, total]) => `
      <div class="bar-row">
        <div class="bar-info">
          <span>${safe(month)}</span>
          <strong>${money(total)}</strong>
        </div>
        <div class="bar">
          <div class="bar-fill" style="width:${total / maxRevenue * 100}%"></div>
        </div>
      </div>
    `).join("") || "<p>No sales recorded yet.</p>";
  }

  const monthKey = currentMonthKey();

  const monthInvoices = invoices.filter(invoice =>
    String(invoice.date || "").slice(0, 7) === monthKey
  );

  const monthlySales = productSalesFor(monthInvoices)
    .sort((a, b) => b.quantity - a.quantity);

  renderBarList(
    "monthlyTopQuantity",
    monthlySales.slice(0, 5),
    "quantity",
    quantity => `${quantity} units`,
    "No sales recorded this month."
  );

  const monthlyByRevenue = productSalesFor(monthInvoices)
    .sort((a, b) => b.revenue - a.revenue);

  renderBarList(
    "monthlyTopRevenue",
    monthlyByRevenue.slice(0, 5),
    "revenue",
    money,
    "No sales recorded this month."
  );

  const allTime = productSalesFor(invoices)
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 5);

  renderBarList(
    "topProducts",
    allTime,
    "quantity",
    quantity => `${quantity} units sold`,
    "No product sales recorded yet."
  );
}

/* ---------- REFRESH ALL SECTIONS ---------- */

function renderAll() {
  products.forEach(product => {
    product.stock = totalStock(product);
  });

  renderDashboard();
  renderInvoices();
  renderInventory();
  renderAnalytics();
  populateProductOptions();
}

on("invoiceSearch", "input", renderInvoices);
on("productSearch", "input", renderInventory);

if ($("date")) $("date").value = todayISO();

if ($("invoiceDateLabel") && $("date")) {
  $("invoiceDateLabel").textContent = $("date").value;
}

if ($("invoiceNumber")) {
  $("invoiceNumber").textContent = "INV-" + nextInvoiceId;
}


async function initializeApp() {
  try {
    products = await fetchProductsFromBackend();
    invoices = await fetchInvoicesFromBackend();

    renderAll();
    notify("Products and invoices loaded from database.");
  } catch (error) {
    console.error("Data loading failed:", error);
    notify("Data load failed. Check backend and Console.");
  }
}

initializeApp();


})();