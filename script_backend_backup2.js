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
  toast.textContent = "Test notification is working!";

  clearTimeout(notify.timer);
  clearTimeout(notify.hideTimer);

  toast.classList.remove("toast-show", "toast-hide");
  toast.style.display = "block";

  requestAnimationFrame(() => {
    toast.classList.add("toast-show");
  });

  notify.hideTimer = setTimeout(() => {
    toast.classList.remove("toast-show");
    toast.classList.add("toast-hide");

    notify.timer = setTimeout(() => {
      toast.style.display = "none";
      toast.classList.remove("toast-hide");
    }, 350);
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
  if (!batch || Number(batch.stock) <= 0) {
    return false;
  }

  const expiryDate = String(batch.expiryDate || "").trim();

  // No expiry date means the product does not expire.
  if (!expiryDate) {
    return true;
  }

  // Products with a past expiry date cannot be sold.
  return expiryDate >= todayISO();
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
    customers: "Customers",
    inventory: "Inventory Management",
    analytics: "Sales Analytics",
    expenses: "Expenses & Profit",
    payments: "Payment Tracking",
    settings: "Settings"
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
  if ($("gst")) {
  $("gst").value = String(getInvoiceProSettings().defaultGst || "18");
}
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
      "Expiry date is optional for products that do not expire. Expired batches and batches with no stock cannot be selected.";
  }
}

let additionalInvoiceItemCounter = 0;

function addAdditionalInvoiceItem() {
  const container = $("additionalInvoiceItems");
  if (!container) return;

  additionalInvoiceItemCounter++;

  const row = document.createElement("div");
  row.className = "form-grid additional-product-row";

  const productField = document.createElement("div");
  productField.className = "field";

  const productLabel = document.createElement("label");
  productLabel.textContent = "Additional Product / Batch";

  const productSelect = document.createElement("select");
  productSelect.className = "additional-product-select";
  productSelect.id = "additionalProduct" + additionalInvoiceItemCounter;

  productLabel.htmlFor = productSelect.id;

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select product / batch";
  productSelect.appendChild(placeholder);

  products.forEach(product => {
    product.batches.forEach(batch => {
      if (!batchSellable(batch)) return;

      const option = document.createElement("option");
      option.value = `${product.id}|${batch.id}`;
      option.textContent =
        `${product.name} — ${batch.number} — ${money(product.price)} — Stock: ${batch.stock}`;

      productSelect.appendChild(option);
    });
  });

  productField.append(productLabel, productSelect);

  const quantityField = document.createElement("div");
  quantityField.className = "field";

  const quantityLabel = document.createElement("label");
  quantityLabel.textContent = "Quantity";

  const quantityInput = document.createElement("input");
  quantityInput.type = "number";
  quantityInput.className = "additional-product-quantity";
  quantityInput.min = "1";
  quantityInput.step = "1";
  quantityInput.value = "1";
  quantityLabel.htmlFor = "additionalQuantity" + additionalInvoiceItemCounter;
  quantityInput.id = quantityLabel.htmlFor;

  quantityField.append(quantityLabel, quantityInput);

  const priceField = document.createElement("div");
  priceField.className = "field";

  const priceLabel = document.createElement("label");
  priceLabel.textContent = "Unit Price";

  const priceOutput = document.createElement("input");
  priceOutput.type = "text";
  priceOutput.className = "additional-product-price";
  priceOutput.value = "";
  priceOutput.readOnly = true;
  priceOutput.placeholder = "Auto-filled";

  priceField.append(priceLabel, priceOutput);

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "btn secondary";
  removeButton.textContent = "Remove";

  row.append(productField, quantityField, priceField, removeButton);
  container.appendChild(row);

  function updateRow() {
    const parts = productSelect.value.split("|");

    const product = parts.length === 2
      ? products.find(p => String(p.id) === parts[0])
      : null;

    const batch = product
      ? product.batches.find(b => String(b.id) === parts[1])
      : null;

    if (!product || !batch || !batchSellable(batch)) {
      priceOutput.value = "";
      quantityInput.removeAttribute("max");
      quantityInput.setCustomValidity("");
      return;
    }

    priceOutput.value = money(product.price);
    quantityInput.max = batch.stock;

    if (Number(quantityInput.value) > batch.stock) {
      quantityInput.value = batch.stock;
    }

    quantityInput.setCustomValidity("");
  }

  productSelect.addEventListener("change", () => {
  updateRow();
  calculateInvoice();
});

  quantityInput.addEventListener("input", () => {
  const value = Number(quantityInput.value);
  const max = Number(quantityInput.max);

  if (
    quantityInput.value !== "" &&
    (!Number.isInteger(value) || value < 1 || value > max)
  ) {
    quantityInput.setCustomValidity(
      "Enter a whole quantity within the available stock."
    );
  } else {
    quantityInput.setCustomValidity("");
  }

  calculateInvoice();
});
  removeButton.addEventListener("click", () => {
    row.remove();
  });
}

on("addInvoiceItemBtn", "click", addAdditionalInvoiceItem);


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
  const primaryQuantity = Math.max(
    0,
    Number($("quantity")?.value) || 0
  );

  const primaryPrice = Math.max(
    0,
    Number($("price")?.value) || 0
  );

  const discountRate = Math.min(
    100,
    Math.max(0, Number($("discount")?.value) || 0)
  );

  const gstRate = Math.max(
    0,
    Number($("gst")?.value) || 0
  );

  const items = [];

  // Main product
  const mainPair = selectedPair();

  const mainProduct = mainPair
    ? products.find(p => String(p.id) === String(mainPair.productId))
    : null;

  const mainBatch = mainPair && mainProduct
    ? mainProduct.batches.find(
        b => String(b.id) === String(mainPair.batchId)
      )
    : null;

  if (mainProduct && mainBatch) {
    items.push({
      productId: mainProduct.id,
      productName: mainProduct.name,
      sku: mainProduct.sku,
      batchId: mainBatch.id,
      batchNumber: mainBatch.number,
      batchExpiry: mainBatch.expiryDate,
      quantity: primaryQuantity,
      price: primaryPrice,
      subtotal: primaryQuantity * primaryPrice
    });
  }

  // Additional products
  document.querySelectorAll(
    "#additionalInvoiceItems .additional-product-row"
  ).forEach(row => {
    const select = row.querySelector(".additional-product-select");
    const quantityInput = row.querySelector(
      ".additional-product-quantity"
    );

    if (!select || !select.value) return;

    const parts = select.value.split("|");

    const product = products.find(
      p => String(p.id) === String(parts[0])
    );

    const batch = product
      ? product.batches.find(
          b => String(b.id) === String(parts[1])
        )
      : null;

    if (!product || !batch) return;

    const quantity = Math.max(
      0,
      Number(quantityInput?.value) || 0
    );

    const price = Math.max(0, Number(product.price) || 0);

    items.push({
      productId: product.id,
      productName: product.name,
      sku: product.sku,
      batchId: batch.id,
      batchNumber: batch.number,
      batchExpiry: batch.expiryDate,
      quantity,
      price,
      subtotal: quantity * price
    });
  });

  // Calculate combined total
  const subtotal = items.reduce(
    (sum, item) => sum + item.subtotal,
    0
  );

  const discount = subtotal * discountRate / 100;
  const taxableAmount = subtotal - discount;
  const tax = taxableAmount * gstRate / 100;
  const total = taxableAmount + tax;

  if ($("subtotal")) {
    $("subtotal").textContent = money(subtotal);
  }

  if ($("discountAmount")) {
    $("discountAmount").textContent = money(discount);
  }

  if ($("taxAmount")) {
    $("taxAmount").textContent = money(tax);
  }

  if ($("grandTotal")) {
    $("grandTotal").textContent = money(total);
  }

  return {
    quantity: primaryQuantity,
    price: primaryPrice,
    subtotal,
    discount,
    tax,
    total,
    items
  };
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
  const phone = String($("phone")?.value || "").trim();

  if (!customer || !phone) {
    return notify("Please enter customer name and phone number.");
  }

  const calculation = calculateInvoice();
  const calculatedItems = Array.isArray(calculation.items)
    ? calculation.items
    : [];

  if (!calculatedItems.length) {
    return notify("Please select at least one product.");
  }

  // Validate every selected product and batch.
  const savedItems = [];

  for (const item of calculatedItems) {
    const product = products.find(
      p => String(p.id) === String(item.productId)
    );

    const batch = product?.batches?.find(
      b => String(b.id) === String(item.batchId)
    );

    const quantity = Number(item.quantity);

    if (
      !product ||
      !batch ||
      !batchSellable(batch) ||
      !Number.isInteger(quantity) ||
      quantity < 1
    ) {
      return notify("Please check each selected product and batch.");
    }

    savedItems.push({
      product_id: Number(item.productId),
      quantity
    });
  }

  // Check combined quantity if the same product is selected more than once.
  const quantities = new Map();

  for (const item of savedItems) {
    const id = String(item.product_id);
    quantities.set(id, (quantities.get(id) || 0) + item.quantity);
  }

  for (const [id, quantity] of quantities) {
    const product = products.find(p => String(p.id) === id);

    if (!product || quantity > Number(product.stock)) {
      return notify("Selected quantity exceeds available product stock.");
    }
  }

  try {
    // Save customer first.
    const customerResponse = await fetch(`${API_BASE}/customers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: customer,
        email,
        phone,
        address: ""
      })
    });

    const customerResult = await customerResponse.json();

    if (!customerResponse.ok) {
      throw new Error(customerResult.error || "Customer save failed.");
    }

    const customerId = Number(customerResult.customer_id);

    if (!customerId) {
      throw new Error("Customer ID was not returned by the backend.");
    }

    // Backend saves the invoice and deducts stock.
    const invoiceResponse = await fetch(`${API_BASE}/invoices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_id: customerId,
        items: savedItems
      })
    });

    const invoiceResult = await invoiceResponse.json();

    if (!invoiceResponse.ok) {
      throw new Error(invoiceResult.error || "Invoice creation failed.");
    }

    // Reload server data; do not deduct stock again in the frontend.
    products = await fetchProductsFromBackend();
    invoices = await fetchInvoicesFromBackend();

    const savedInvoice = invoices.find(
      inv => Number(inv.backendId) === Number(invoiceResult.invoice_id)
    );

    if (savedInvoice) {
      currentInvoice = savedInvoice;
    }

    saveData();
    renderAll();

    if ($("invoiceNumber")) {
      $("invoiceNumber").textContent =
        `INV-${invoiceResult.invoice_id}`;
    }

    notify("Invoice saved successfully!");

  } catch (error) {
    console.error("Invoice save failed:", error);
    notify(error.message || "Invoice save failed. Check the backend.");
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

/* ---------- PRINT / SAVE PDF IN SELECTED LANGUAGE ---------- */

on("printBtn", "click", () => {
  const customer = $("customer")?.value.trim() || "";
  const phone = String($("phone")?.value || "").trim();
  const pair = selectedPair();

  const product = pair
    ? products.find(p => String(p.id) === String(pair.productId))
    : null;

  const batch = pair && product
    ? product.batches.find(
        b => String(b.id) === String(pair.batchId)
      )
    : null;

  if (!customer || !phone || !product || !batch) {
    return notify(
      "Please enter customer name and phone number, and select a product batch."
    );
  }

  if (!batchSellable(batch)) {
    return notify(
      "The selected batch is expired or unavailable."
    );
  }

  const calc = calculateInvoice();

  if (!Array.isArray(calc.items) || calc.items.length === 0) {
    return notify("Please select at least one product.");
  }

  // Validate every selected product and batch before printing.
  const stockUsage = new Map();

  for (const item of calc.items) {
    const itemProduct = products.find(
      p => String(p.id) === String(item.productId)
    );

    const itemBatch = itemProduct?.batches.find(
      b => String(b.id) === String(item.batchId)
    );

    const quantity = Number(item.quantity);

    if (
      !itemProduct ||
      !itemBatch ||
      !batchSellable(itemBatch) ||
      !Number.isInteger(quantity) ||
      quantity < 1
    ) {
      return notify(
        "Please check each product, batch, and quantity."
      );
    }

    const key = `${item.productId}|${item.batchId}`;

    stockUsage.set(
      key,
      (stockUsage.get(key) || 0) + quantity
    );
  }

  // Check combined quantities if the same batch is selected more than once.
  for (const [key, quantity] of stockUsage) {
    const [productId, batchId] = key.split("|");

    const itemProduct = products.find(
      p => String(p.id) === productId
    );

    const itemBatch = itemProduct?.batches.find(
      b => String(b.id) === batchId
    );

    if (!itemBatch || quantity > Number(itemBatch.stock)) {
      return notify(
        "Selected product quantity exceeds available stock."
      );
    }
  }

  // Include all items and their saved product costs in the print data.
  const printItems = calc.items.map(item => {
    const itemProduct = products.find(
      p => String(p.id) === String(item.productId)
    );

    return {
      ...item,
      costPrice: itemProduct?.costPrice ?? null
    };
  });

  const firstItem = printItems[0];

  const invoice = {
    id: currentInvoice?.id || "INV-" + nextInvoiceId,
    customer,
    email: $("email")?.value.trim() || "",
    phone,
    date: $("date")?.value || todayISO(),
    status: $("status")?.value || "Pending",

    // Keep first-product fields for compatibility with existing code.
    productId: firstItem.productId,
    productName: firstItem.productName,
    sku: firstItem.sku,
    batchId: firstItem.batchId,
    batchNumber: firstItem.batchNumber,
    batchExpiry: firstItem.batchExpiry,
    quantity: firstItem.quantity,
    price: firstItem.price,
    costPrice: firstItem.costPrice,

    // This is the important part: pass EVERY selected product to the PDF.
    items: printItems,

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
  const query = ($("invoiceSearch")?.value || "").toLowerCase().trim();

  const getItems = invoice => {
    if (Array.isArray(invoice.items) && invoice.items.length) {
      return invoice.items;
    }

    // Keep older single-product invoices compatible.
    return [{
      productName: invoice.productName || "Product",
      batchNumber: invoice.batchNumber || "Legacy",
      quantity: invoice.quantity
    }];
  };

  const filtered = invoices.filter(invoice => {
    const items = getItems(invoice);

    const productNames = items
      .map(item => String(item.productName || "Product"))
      .join(" ");

    return (
      String(invoice.id || "").toLowerCase().includes(query) ||
      String(invoice.customer || "").toLowerCase().includes(query) ||
      productNames.toLowerCase().includes(query)
    );
  });

  if (!$("invoiceTable")) return;

  
  $("invoiceTable").innerHTML = filtered.map(invoice => {
    const items = getItems(invoice);

    const productSummary = items.map(item => {
      const name = String(item.productName || "Product");
      const quantity = Number(item.quantity) || 0;

      return quantity ? `${name} × ${quantity}` : name;
    }).join(", ");

    const batchSummary = items
      .map(item => String(item.batchNumber || "Legacy"))
      .join(", ");

    const status = String(invoice.status || "");
    const statusClass = status.toLowerCase() === "paid"
      ? "paid"
      : status.toLowerCase() === "pending"
        ? "pending"
        : "";

    return `
      <tr>
        <td>${safe(invoice.id)}</td>
        <td>${safe(invoice.customer)}</td>
        <td>${safe(invoice.date)}</td>
        <td>${safe(productSummary)}</td>
        <td>${safe(batchSummary)}</td>
        <td>${money(invoice.total)}</td>
        <td>
          <span class="status ${statusClass}">
            ${safe(status)}
          </span>
        </td>
        <td>
          <button class="btn secondary small-btn" data-print="${safe(invoice.id)}">Print</button>
          <button class="btn secondary small-btn" data-status="${safe(invoice.id)}">Change Status</button>
        </td>
      </tr>
    `;
  }).join("") ||
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
  const businessSettings = getInvoiceProSettings();

  const t = hindi ? {
    invoice: "चालान",
    business: businessSettings.businessName || "InvoicePro व्यवसाय समाधान",
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
    business: businessSettings.businessName || "InvoicePro Business Solutions",
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
    
const printItems =
  Array.isArray(invoice.items) && invoice.items.length
    ? invoice.items
    : [{
        productName: invoice.productName || "Product",
        batchNumber: invoice.batchNumber || "Legacy",
        batchExpiry: invoice.batchExpiry || "",
        quantity: invoice.quantity,
        price: invoice.price,
        subtotal: invoice.subtotal
      }];

const expiryLines = printItems
  .filter(item => String(item.batchExpiry || "").trim())
  .map(item =>
    `<p>${safe(item.productName || "Product")} — ${safe(t.expiry)}: ${safe(item.batchExpiry)}</p>`
  )
  .join("");


  paper.innerHTML = `
    <div class="print-invoice" lang="${hindi ? "hi" : "en"}">
      <div class="invoice-header">
        <div>
          <h2>${safe(t.invoice)}</h2>
          
<p>${safe(t.business)}</p>
${businessSettings.businessAddress
  ? `<p>${safe(businessSettings.businessAddress)}</p>`
  : ""}
${businessSettings.businessPhone
  ? `<p>Phone: ${safe(businessSettings.businessPhone)}</p>`
  : ""}
${businessSettings.businessEmail
  ? `<p>Email: ${safe(businessSettings.businessEmail)}</p>`
  : ""}

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
  ${printItems.map(item => {
    const quantity = Number(item.quantity) || 0;
    const unitPrice = Number(item.price) || 0;

    const amount =
      item.subtotal !== undefined &&
      item.subtotal !== null &&
      item.subtotal !== ""
        ? Number(item.subtotal) || 0
        : quantity * unitPrice;

    return `
      <tr>
        <td>${safe(item.productName || "Product")}</td>
        <td>${safe(item.batchNumber || "Legacy")}</td>
        <td>${quantity}</td>
        <td>${money(unitPrice)}</td>
        <td>${money(amount)}</td>
      </tr>
    `;
  }).join("")}
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
  const costPrice = Number($("productCost")?.value);
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
if (
  !Number.isFinite(price) ||
  price < 0 ||
  !Number.isFinite(costPrice) ||
  costPrice < 0 ||
  !Number.isInteger(stock) ||
  stock < 0 ||
  !Number.isInteger(threshold) ||
  threshold < 0
) {
  return notify(
    "Check selling price, cost price, stock and low-stock threshold values."
  );
}
  if (products.some(p => p.sku.toLowerCase() === sku.toLowerCase())) {
    return notify("This product ID already exists.");
  }

  if (products.some(p =>
    p.batches.some(b => b.number.toLowerCase() === batchNumber.toLowerCase())
  )) {
    return notify("This batch number already exists.");
  }

  const product = {
    id: Date.now(),
    name,
    sku,
    price,
    costPrice,
    threshold,
    gst: Number($("productGst")?.value) || 0,
    batches: [{
      id: `b-${Date.now()}`,
      number: batchNumber,
      stock,
      expiryDate
    }]
  };

  product.stock = stock;
  products.push(product);

  saveData();
  event.target.reset();

  if ($("threshold")) $("threshold").value = 5;

  renderAll();
  notify("Product and first batch added successfully.");
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

function renderCustomers() {
  const table = $("customersTable");
  if (!table) return;

  const query = ($("customersSearch")?.value || "")
    .trim()
    .toLowerCase();

  const customerMap = new Map();

  invoices.forEach(invoice => {
    const name = String(invoice.customer || "Unknown").trim();
    const email = String(invoice.email || "").trim();

    // Ignore incorrectly stored phone values.
    const rawPhone = invoice.phone;

    const phone =
      typeof rawPhone === "string" &&
      rawPhone.trim() !== "" &&
      !rawPhone.includes("HTMLInputElement") &&
      rawPhone !== "[object Object]"
        ? rawPhone.trim()
        : "";

    // Group by valid phone, then email, then customer name.
    const normalizedName = name
  .toLowerCase()
  .replace(/\s+/g, " ");

const normalizedEmail = email.toLowerCase();

const normalizedPhone = phone.replace(/\D/g, "");

const key = normalizedEmail
  ? "email:" + normalizedEmail + "|name:" + normalizedName
  : normalizedPhone
    ? "phone:" + normalizedPhone
    : "name:" + normalizedName;
    if (!customerMap.has(key)) {
      customerMap.set(key, {
        name,
        phone,
        email,
        invoiceCount: 0,
        totalSpent: 0,
        products: new Set(),
        invoiceIds: [],
        lastDate: ""
      });
    }

    const customer = customerMap.get(key);

    customer.invoiceCount++;
    customer.totalSpent += Number(invoice.total) || 0;

    if (!customer.phone && phone) {
      customer.phone = phone;
    }

    if (!customer.email && email) {
      customer.email = email;
    }

    const productName = invoice.productName || "Unknown product";
    const batchText = invoice.batchNumber
      ? " (Batch " + invoice.batchNumber + ")"
      : "";

    customer.products.add(productName + batchText);
    customer.invoiceIds.push(invoice.id || "N/A");

    const invoiceDate = String(invoice.date || "");

    if (invoiceDate > customer.lastDate) {
      customer.lastDate = invoiceDate;
    }
  });

  const customers = Array.from(customerMap.values())
    .filter(customer => {
      const searchText = [
        customer.name,
        customer.phone,
        customer.email,
        ...customer.products,
        ...customer.invoiceIds
      ].join(" ").toLowerCase();

      return searchText.includes(query);
    })
    .sort((a, b) => b.lastDate.localeCompare(a.lastDate));

  table.innerHTML = customers.map(customer => `
    <tr>
      <td>${safe(customer.name)}</td>
      <td>${safe(customer.phone || "Not recorded")}</td>
      <td>${safe(customer.email || "—")}</td>
      <td>${safe([...customer.products].join(", "))}</td>
      <td>${customer.invoiceCount}</td>
      <td>${money(customer.totalSpent)}</td>
      <td>${safe(customer.invoiceIds.join(", "))}</td>
    </tr>
  `).join("") || `
    <tr>
      <td colspan="7">No customer records found.</td>
    </tr>
  `;
}

on("customersSearch", "input", renderCustomers);

/* ===== EXPENSES & PROFIT ===== */

function getSavedExpenses() {
  try {
    const data = JSON.parse(
      localStorage.getItem("invoice_expenses") || "[]"
    );

    return Array.isArray(data) ? data : [];
  } catch (error) {
    return [];
  }
}

function saveExpenseRecords(records) {
  try {
    localStorage.setItem(
      "invoice_expenses",
      JSON.stringify(records)
    );

    return true;
  } catch (error) {
    notify("Expenses could not be saved in browser storage.");
    return false;
  }
}

function renderExpenses() {
  
const selectedMonth =
  $("expenseReportMonth")?.value || todayISO().slice(0, 7);

const expenses = getSavedExpenses().filter(expense =>
  String(expense.date || "").slice(0, 7) === selectedMonth
);

const revenue = invoices
  .filter(invoice =>
    String(invoice.date || "").slice(0, 7) === selectedMonth
  )
  .reduce(
    (sum, invoice) => sum + (Number(invoice.total) || 0),
    0
  );

const totalExpenses = expenses.reduce(
  (sum, expense) => sum + (Number(expense.amount) || 0),
  0
);

const estimatedProfit = revenue - totalExpenses;


  if ($("expenseRevenue")) {
    $("expenseRevenue").textContent = money(revenue);
  }

  if ($("expenseTotal")) {
    $("expenseTotal").textContent = money(totalExpenses);
  }

  if ($("estimatedProfit")) {
    $("estimatedProfit").textContent = money(estimatedProfit);
  }

  const table = $("expenseTable");
  if (!table) return;

  const query = ($("expenseSearch")?.value || "")
    .trim()
    .toLowerCase();

  const filtered = expenses
    .filter(expense => {
      const searchable = [
        expense.date,
        expense.category,
        expense.description,
        expense.amount
      ].join(" ").toLowerCase();

      return searchable.includes(query);
    })
    .sort((a, b) =>
      String(b.date || "").localeCompare(String(a.date || ""))
    );

  table.innerHTML = filtered.map(expense => `
    <tr>
      <td>${safe(expense.date || "")}</td>
      <td>${safe(expense.category || "Other")}</td>
      <td>${safe(expense.description || "")}</td>
      <td>${money(Number(expense.amount) || 0)}</td>
      <td>
        <button
          type="button"
          class="btn secondary small-btn"
          data-delete-expense="${safe(expense.id)}"
        >
          Delete
        </button>
      </td>
    </tr>
  `).join("") || `
    <tr>
      <td colspan="5" class="empty">No expense records found.</td>
    </tr>
  `;
}

// Set the default date when the page loads.
if ($("expenseDate")) {
  $("expenseDate").value = todayISO();
}

// Save a new expense.
on("expenseForm", "submit", event => {
  event.preventDefault();

  const date = $("expenseDate")?.value || "";
  const category = $("expenseCategory")?.value || "Other";
  const description =
    $("expenseDescription")?.value.trim() || "";
  const amount = Number($("expenseAmount")?.value);

  if (!date || !description) {
    return notify("Please enter the expense date and description.");
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return notify("Please enter an expense amount greater than zero.");
  }

  const expenses = getSavedExpenses();

  expenses.unshift({
    id: "EXP-" + Date.now() + "-" +
      Math.random().toString(36).slice(2, 7),
    date,
    category,
    description,
    amount: Math.round(amount * 100) / 100
  });

  if (!saveExpenseRecords(expenses)) return;

  event.currentTarget.reset();

  if ($("expenseDate")) {
    $("expenseDate").value = todayISO();
  }

  renderExpenses();
  notify("Expense saved successfully.");
});

// Search expense history.
on("expenseSearch", "input", renderExpenses);
if ($("expenseReportMonth")) {
  $("expenseReportMonth").value = todayISO().slice(0, 7);
}

on("expenseReportMonth", "change", renderExpenses);

// Delete a selected expense record.
on("expenseTable", "click", event => {
  const button = event.target.closest("[data-delete-expense]");
  if (!button) return;

  if (!confirm("Delete this expense record?")) return;

  const id = button.getAttribute("data-delete-expense");

  const expenses = getSavedExpenses().filter(
    expense => String(expense.id) !== String(id)
  );

  if (!saveExpenseRecords(expenses)) return;

  renderExpenses();
  notify("Expense deleted successfully.");
});

/* ===== PARTIAL PAYMENT TRACKING ===== */

// Convert currency to integer paise to avoid rounding errors.
function getInvoiceTotalCents(invoice) {
  return Math.max(
    0,
    Math.round((Number(invoice.total) || 0) * 100)
  );
}

// Support older invoices that do not have amountPaid yet.
function getInvoicePaidCents(invoice) {
  const totalCents = getInvoiceTotalCents(invoice);

  if (
    invoice.amountPaid !== undefined &&
    invoice.amountPaid !== null &&
    invoice.amountPaid !== ""
  ) {
    const value = Number(invoice.amountPaid);
    const paidCents = Number.isFinite(value)
      ? Math.round(value * 100)
      : 0;

    return Math.min(totalCents, Math.max(0, paidCents));
  }

  // Existing Paid invoices are treated as fully paid.
  return String(invoice.status || "").toLowerCase() === "paid"
    ? totalCents
    : 0;
}

function getInvoicePaymentStatus(invoice) {
  const totalCents = getInvoiceTotalCents(invoice);
  const paidCents = getInvoicePaidCents(invoice);

  if (paidCents >= totalCents) return "Paid";
  if (paidCents > 0) return "Partial";
  return "Pending";
}

function renderPayments() {
  const invoicesWithBalance = invoices.filter(invoice =>
    getInvoiceTotalCents(invoice) > getInvoicePaidCents(invoice)
  );

  const totalPaidCents = invoices.reduce(
    (sum, invoice) => sum + getInvoicePaidCents(invoice),
    0
  );

  const totalDueCents = invoices.reduce(
    (sum, invoice) =>
      sum + Math.max(
        0,
        getInvoiceTotalCents(invoice) - getInvoicePaidCents(invoice)
      ),
    0
  );

  if ($("paymentTotalPaid")) {
    $("paymentTotalPaid").textContent = money(totalPaidCents / 100);
  }

  if ($("paymentTotalPending")) {
    $("paymentTotalPending").textContent = money(totalDueCents / 100);
  }

  if ($("paymentPendingCount")) {
    $("paymentPendingCount").textContent = invoicesWithBalance.length;
  }

  const table = $("paymentTrackingTable");
  if (!table) return;

  const query = ($("paymentSearch")?.value || "")
    .trim()
    .toLowerCase();

  const filtered = invoices.filter(invoice => {
    const searchable = [
      invoice.id,
      invoice.customer,
      invoice.phone,
      invoice.date,
      invoice.status
    ].join(" ").toLowerCase();

    return searchable.includes(query);
  });

  table.innerHTML = filtered.map(invoice => {
    const totalCents = getInvoiceTotalCents(invoice);
    const paidCents = getInvoicePaidCents(invoice);
    const dueCents = Math.max(0, totalCents - paidCents);
    const status = getInvoicePaymentStatus(invoice);

    const history = Array.isArray(invoice.paymentHistory)
      ? invoice.paymentHistory
      : [];

    const historyText = history.length
      ? history.map(payment =>
          `${payment.date || "Date unavailable"}: ${money(Number(payment.amount) || 0)}`
        ).join(" | ")
      : paidCents > 0
        ? "Previously paid; details unavailable"
        : "No payments recorded";

    const rawPhone = String(invoice.phone || "").trim();
    const phone =
      rawPhone && !rawPhone.includes("HTMLInputElement")
        ? rawPhone
        : "Not recorded";

    return `
      <tr>
        <td>${safe(invoice.id)}</td>
        <td>${safe(invoice.customer || "Unknown")}</td>
        <td>${safe(phone)}</td>
        <td>${safe(invoice.date || "")}</td>
        <td>${money(totalCents / 100)}</td>
        <td>${money(paidCents / 100)}</td>
        <td>${money(dueCents / 100)}</td>
        <td>
          <span class="status ${status.toLowerCase()}">
            ${safe(status)}
          </span>
        </td>
        <td>${safe(historyText)}</td>
        <td>
          <button
            type="button"
            class="btn secondary small-btn"
            data-record-payment="${safe(invoice.id)}"
            ${dueCents <= 0 ? "disabled" : ""}
          >
            ${dueCents <= 0 ? "Fully Paid" : "Record Payment"}
          </button>
        </td>
      </tr>
    `;
  }).join("") || `
    <tr>
      <td colspan="10" class="empty">No payment records found.</td>
    </tr>
  `;
}

// Search payment records.
on("paymentSearch", "input", renderPayments);

// Record a full or partial payment.
on("paymentTrackingTable", "click", event => {
  const button = event.target.closest("[data-record-payment]");
  if (!button) return;

  const invoice = invoices.find(
    item => String(item.id) === String(button.dataset.recordPayment)
  );

  if (!invoice) {
    return notify("Invoice was not found.");
  }

  const totalCents = getInvoiceTotalCents(invoice);
  const paidCents = getInvoicePaidCents(invoice);
  const dueCents = Math.max(0, totalCents - paidCents);

  if (dueCents <= 0) {
    return notify("This invoice is already fully paid.");
  }

  const entered = prompt(
    `Invoice: ${invoice.id}\n` +
    `Total: ${money(totalCents / 100)}\n` +
    `Paid so far: ${money(paidCents / 100)}\n` +
    `Balance due: ${money(dueCents / 100)}\n\n` +
    "Enter the amount received (₹):",
    (dueCents / 100).toFixed(2)
  );

  if (entered === null) return;

  if (!entered.trim()) {
    return notify("Please enter the payment amount.");
  }

  const amount = Number(entered);

  if (!Number.isFinite(amount) || amount <= 0) {
    return notify("Payment must be greater than zero.");
  }

  const receivedCents = Math.round(amount * 100);

  if (receivedCents <= 0) {
    return notify("Enter a valid payment amount.");
  }

  if (receivedCents > dueCents) {
    return notify(
      `Payment cannot exceed the balance due of ${money(dueCents / 100)}.`
    );
  }

  const newPaidCents = paidCents + receivedCents;

  // Store the cumulative amount received for this invoice.
  invoice.amountPaid = newPaidCents / 100;

  // Preserve a separate history of each payment.
  if (!Array.isArray(invoice.paymentHistory)) {
    invoice.paymentHistory = [];
  }

  invoice.paymentHistory.push({
    id: "PAY-" + Date.now(),
    date: todayISO(),
    amount: receivedCents / 100
  });

  invoice.status = getInvoicePaymentStatus(invoice);

  saveData();
  renderAll();

  if (invoice.status === "Paid") {
    notify("Payment recorded. Invoice is fully paid.");
  } else {
    notify(
      `Partial payment recorded. Remaining balance: ${money((totalCents - newPaidCents) / 100)}.`
    );
  }
});


/* ===== MOST PROFITABLE PRODUCTS ===== */

function renderMostProfitableProducts() {
  const table = $("mostProfitableTable");
  if (!table) return;

  const productMap = new Map();

  invoices.forEach(invoice => {
    let items;

    if (Array.isArray(invoice.items) && invoice.items.length) {
      items = invoice.items;
    } else {
      // Backward compatibility for old single-product invoices.
      items = [{
        productId: invoice.productId,
        productName: invoice.productName || "Product",
        sku: invoice.sku,
        quantity: invoice.quantity,
        price: invoice.price,
        subtotal: invoice.subtotal,
        discount: invoice.discount,
        costPrice: invoice.costPrice
      }];
    }

    const invoiceSubtotal = items.reduce((sum, item) => {
      const quantity = Number(item.quantity) || 0;
      const price = Number(item.price) || 0;

      const subtotal =
        item.subtotal !== undefined &&
        item.subtotal !== null &&
        item.subtotal !== ""
          ? Number(item.subtotal)
          : quantity * price;

      return sum + (Number.isFinite(subtotal) ? subtotal : 0);
    }, 0);

    items.forEach(item => {
      const quantity = Number(item.quantity) || 0;
      if (quantity <= 0) return;

      const price = Number(item.price) || 0;

      const subtotal =
        item.subtotal !== undefined &&
        item.subtotal !== null &&
        item.subtotal !== ""
          ? Number(item.subtotal)
          : quantity * price;

      const itemDiscount =
        item.discount !== undefined &&
        item.discount !== null &&
        item.discount !== ""
          ? Number(item.discount) || 0
          : invoiceSubtotal > 0
            ? (Number(invoice.discount) || 0) *
              subtotal / invoiceSubtotal
            : 0;

      const netSales = Math.max(0, subtotal - itemDiscount);

      let costValue = item.costPrice;

      // Use the invoice-level cost only for single-product invoices.
      if (
        (costValue === undefined ||
          costValue === null ||
          costValue === "") &&
        items.length === 1
      ) {
        costValue = invoice.costPrice;
      }
      
/* If the old invoice has no saved cost, use the product's inventory cost. */
if (
  costValue === undefined ||
  costValue === null ||
  costValue === ""
) {
  const inventoryProduct = products.find(p =>
    item.productId !== undefined &&
    item.productId !== null &&
    String(p.id) === String(item.productId)
  ) || products.find(p =>
    item.sku &&
    String(p.sku).toLowerCase() === String(item.sku).toLowerCase()
  ) || products.find(p =>
    String(p.name || "").trim().toLowerCase() ===
    String(item.productName || "").trim().toLowerCase()
  );

  if (
    inventoryProduct &&
    inventoryProduct.costPrice !== undefined &&
    inventoryProduct.costPrice !== null &&
    inventoryProduct.costPrice !== "" &&
    Number.isFinite(Number(inventoryProduct.costPrice)) &&
    Number(inventoryProduct.costPrice) >= 0
  ) {
    costValue = Number(inventoryProduct.costPrice);
  }
}


      const hasCost =
        costValue !== undefined &&
        costValue !== null &&
        costValue !== "" &&
        Number.isFinite(Number(costValue)) &&
        Number(costValue) >= 0;

      const name = String(item.productName || "Product");

      const key = item.productId !== undefined &&
                  item.productId !== null
        ? "id:" + item.productId
        : item.sku
          ? "sku:" + String(item.sku).toLowerCase()
          : "name:" + name.toLowerCase();

      if (!productMap.has(key)) {
        productMap.set(key, {
          name,
          unitsSold: 0,
          netSales: 0,
          costOfGoods: 0,
          hasMissingCost: false
        });
      }

      const product = productMap.get(key);

      product.unitsSold += quantity;
      product.netSales += netSales;

      if (hasCost) {
        product.costOfGoods += Number(costValue) * quantity;
      } else {
        product.hasMissingCost = true;
      }
    });
  });

  const rows = Array.from(productMap.values()).map(product => {
    const grossProfit = product.hasMissingCost
      ? null
      : product.netSales - product.costOfGoods;

    const profitMargin =
      grossProfit !== null && product.netSales > 0
        ? grossProfit / product.netSales * 100
        : null;

    return {
      ...product,
      grossProfit,
      profitMargin
    };
  });

  // Products with complete cost records rank first.
  rows.sort((a, b) => {
    if (a.hasMissingCost !== b.hasMissingCost) {
      return a.hasMissingCost ? 1 : -1;
    }

    if (a.hasMissingCost) {
      return b.netSales - a.netSales;
    }

    return b.grossProfit - a.grossProfit;
  });

  let rank = 0;

  table.innerHTML = rows.map(product => {
    const rankLabel = product.hasMissingCost
      ? "—"
      : String(++rank);

    return `
      <tr>
        <td>${rankLabel}</td>
        <td>${safe(product.name)}</td>
        <td>${product.unitsSold}</td>
        <td>${money(product.netSales)}</td>
        <td>${
          product.hasMissingCost
            ? "Cost missing"
            : money(product.costOfGoods)
        }</td>
        <td>${
          product.grossProfit === null
            ? "Cost required"
            : money(product.grossProfit)
        }</td>
        <td>${
          product.profitMargin === null
            ? "—"
            : product.profitMargin.toFixed(1) + "%"
        }</td>
      </tr>
    `;
  }).join("") || `
    <tr>
      <td colspan="7" class="empty">
        No product sales found yet.
      </td>
    </tr>
  `;
}


/* ===== INVOICEPRO SETTINGS ===== */

const INVOICEPRO_SETTINGS_KEY = "invoicepro_settings_v1";

function getInvoiceProSettings() {
  const defaults = {
    businessName: "InvoicePro Business Solutions",
    businessPhone: "",
    businessAddress: "",
    businessEmail: "",
    defaultGst: "18",
    pdfLanguage: "en"
  };

  try {
    const saved = JSON.parse(
      localStorage.getItem(INVOICEPRO_SETTINGS_KEY) || "{}"
    );

    return {
      ...defaults,
      ...(saved && typeof saved === "object" ? saved : {})
    };
  } catch (error) {
    return defaults;
  }
}

function loadSettingsForm() {
  const settings = getInvoiceProSettings();

  if ($("settingsBusinessName")) {
    $("settingsBusinessName").value = settings.businessName;
  }

  if ($("settingsBusinessPhone")) {
    $("settingsBusinessPhone").value = settings.businessPhone;
  }

  if ($("settingsBusinessAddress")) {
    $("settingsBusinessAddress").value = settings.businessAddress;
  }

  if ($("settingsBusinessEmail")) {
    $("settingsBusinessEmail").value = settings.businessEmail;
  }

  if ($("settingsDefaultGst")) {
    $("settingsDefaultGst").value = String(settings.defaultGst);
  }

  if ($("settingsPdfLanguage")) {
    $("settingsPdfLanguage").value = settings.pdfLanguage;
  }

  if ($("pdfLanguage")) {
    $("pdfLanguage").value = settings.pdfLanguage;
  }
}

// Save business information and invoice preferences.
on("settingsForm", "submit", event => {
  event.preventDefault();

  const settings = {
    businessName: $("settingsBusinessName")?.value.trim() || "",
    businessPhone: $("settingsBusinessPhone")?.value.trim() || "",
    businessAddress: $("settingsBusinessAddress")?.value.trim() || "",
    businessEmail: $("settingsBusinessEmail")?.value.trim() || "",
    defaultGst: $("settingsDefaultGst")?.value || "18",
    pdfLanguage: $("settingsPdfLanguage")?.value || "en"
  };

  if (!settings.businessName) {
    return notify("Please enter your business name.");
  }

  try {
    localStorage.setItem(
      INVOICEPRO_SETTINGS_KEY,
      JSON.stringify(settings)
    );
  } catch (error) {
    return notify("Settings could not be saved in browser storage.");
  }

  // Update the existing PDF language selector.
  if ($("pdfLanguage")) {
    $("pdfLanguage").value = settings.pdfLanguage;
  }

  notify("Settings saved successfully.");
});

// Reuse the existing working Light/Dark Mode control.
on("settingsThemeToggle", "click", () => {
  const existingToggle = $("darkModeToggle");

  if (existingToggle) {
    existingToggle.click();
  } else {
    notify("The existing theme toggle was not found.");
  }
});

// Load saved settings once when the page starts.
loadSettingsForm();

function renderAll() {
  products.forEach(product => {
    product.stock = totalStock(product);
  });

  renderDashboard();
  renderInvoices();
  renderPayments();
  renderCustomers();
  renderInventory();
  renderAnalytics();
  renderMostProfitableProducts();
  renderExpenses();
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

// Restore the user's saved theme preference dark theme
(() => {
  const darkModeButton = document.getElementById("darkModeToggle");

  if (!darkModeButton) return;

  // Restore the user's saved theme preference
  const savedTheme = localStorage.getItem("invoicepro_theme");
  const isDark = savedTheme === "dark";

  document.body.classList.toggle("dark-mode", isDark);
  updateDarkModeButton(isDark);

  function updateDarkModeButton(dark) {
    darkModeButton.textContent = dark
      ? "☀️ Light Mode"
      : "🌙 Dark Mode";

    darkModeButton.setAttribute("aria-pressed", String(dark));
  }

  darkModeButton.addEventListener("click", () => {
    const dark = !document.body.classList.contains("dark-mode");

    document.body.classList.toggle("dark-mode", dark);
    localStorage.setItem("invoicepro_theme", dark ? "dark" : "light");

    updateDarkModeButton(dark);
  });
})();
