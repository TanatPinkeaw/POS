# Software Requirements Specification (SRS)
## Realtime POS, Inventory, 4-Phase Pre-order & Staff Management System

---

## 1. System Overview & Architecture

### 1.1 Goal
A unified system combining Point of Sale (POS) operations, real-time inventory synchronization, online pre-order booking (4-phase workflow), staff shift & attendance tracking, role-based access control (RBAC), loyalty reward points, and automated reporting with Excel exports.

### 1.2 Target Technology Stack Recommendations
- **Backend:** Node.js (NestJS / Express) or Go / Python (FastAPI)
- **Database:** PostgreSQL (with transaction locking and triggers)
- **Realtime Layer:** WebSockets (Socket.io) or PostgreSQL `LISTEN`/`NOTIFY` / Redis Pub/Sub
- **Export Utility:** ExcelJS or SheetJS
- **Frontend:** Next.js / React (Tailwind CSS)

---

## 2. Role-Based Access Control (RBAC)

| Role | Description | Permissions |
| :--- | :--- | :--- |
| **Member** | Customers ordering online or shopping in-store | - Browse products, live stock availability<br>- Place reservations / pre-orders<br>- Realtime order status tracking with Pickup PIN/QR<br>- View loyalty points balance and transaction history |
| **Employee** | Cashiers, floor staff, inventory clerks | - POS terminal checkout (barcode scan, receipt)<br>- Check-in / check-out work attendance<br>- View assigned work schedule (Read-only)<br>- Manage pre-order phases (Confirm, Pack, Complete)<br>- Stock adjustments (Increment/Decrement with mandatory reason)<br>- Manage cash drawer (Open/Close shift) |
| **Admin** | Business owner, store manager | - Full system access<br>- Product CRUD, pricing, cost, categories, image upload<br>- Create & modify staff work schedules<br>- View attendance logs and calculate work hours<br>- Access sales dashboards and financial analytics<br>- Export reports to Excel (`.xlsx`)<br>- Void/Refund order approval |

---

## 3. Pre-Order Booking Flow (4-Phase Lifecycle)

```
[Phase 1: Pending] ────> [Phase 2: Confirmed] ────> [Phase 3: Ready for Pickup] ────> [Phase 4: Completed]
        │                         │                           │
        ▼                         ▼                           ▼
[Cancelled / Expired]     [Cancelled / Out of Stock]   [Cancelled / No Show]
(Stock Restored)          (Stock Restored)             (Stock Restored)
```

### Detailed Phase Logic
1. **Phase 1: Pending (Order Placed)**
   - Customer places order online.
   - Realtime alert (visual badge + sound effect) pushes to Employee POS screen.
   - Inventory item moves from available pool to `reserved_qty` via atomic row update.
   - **Timeout Guard:** If employee does not confirm within 15 minutes, order auto-expires (`status = cancelled`), and `reserved_qty` is freed.

2. **Phase 2: Confirmed (Processing)**
   - Employee reviews the items and accepts the order.
   - Customer receives real-time notification: "Store is preparing your order".
   - *Partial Confirmation:* If an item is physically broken/unavailable, employee can remove the item, update order total, or notify the customer before proceeding.

3. **Phase 3: Ready for Pickup (Packed & Waiting)**
   - Staff finishes packing, tags the order, and updates status to `ready_for_pickup`.
   - Customer receives notification with a unique **Pickup PIN (4 digits)** and **Order QR code**.
   - **Holding Time Limit:** Default hold time window (e.g., 2–4 hours or by end of business day). If customer fails to claim, staff/system can flag as `no-show` and restock.

4. **Phase 4: Completed (Handover & Settlement)**
   - Customer arrives, presents QR code/PIN/registered phone number.
   - Staff verifies order, processes payment (Cash, PromptPay, or Points Redemption).
   - Once payment is settled:
     - `stock_qty` decreases by order quantity.
     - `reserved_qty` decreases by order quantity.
     - Loyalty points are awarded to customer account.
     - Order status marks `completed`.

---

## 4. Real-time Inventory & Concurrency Rules

### 4.1 Stock Representation
- `stock_qty`: Physical count currently inside the store.
- `reserved_qty`: Count claimed by active Phase 1–3 pre-orders.
- **Available For Sale:** `available_qty = stock_qty - reserved_qty`.

### 4.2 Concurrency / Race Condition Prevention
To prevent overselling when online customers reserve simultaneously or during walk-in POS checkout, enforce row-level locking:
```sql
-- Atomic check and reservation
UPDATE products
SET reserved_qty = reserved_qty + :requested_qty,
    updated_at = NOW()
WHERE id = :product_id 
  AND (stock_qty - reserved_qty) >= :requested_qty;
```
If affected rows equal 0, the API must reject the request with `HTTP 409 Conflict: Insufficient stock`.

### 4.3 Stock Adjustment Audit Trail
When an Employee or Admin updates stock numbers:
- Requires a mandatory enum: `REASON_RESTOCK`, `REASON_DAMAGED`, `REASON_EXPIRED`, `REASON_CORRECTION`.
- System creates a row in `stock_logs` documenting `user_id`, `qty_changed`, `balance_after`, and `note`.

---

## 5. Loyalty Points & Membership System

### 5.1 Business Rules
- **Earning Rule:** Every **3 THB** spent = **1 Point**.
  - Formula: $\text{Points Earned} = \lfloor \frac{\text{Final Paid Amount}}{3} \rfloor$
  - Must calculate only on the final net cash/PromptPay paid amount (excluding discount deductions).
- **Redemption Rule:** **100 Points** = **1 THB** discount (0.01 THB value per point).
  - Minimum redeem block: Typically multiples of 100 points.
- **Point Ledger:** Every change must log to `point_transactions` with `balance_after`.

---

## 6. Staff Attendance & POS Cash Shift System

### 6.1 Work Schedule vs. Time Tracking
- **Work Schedules:** Admin sets `shift_date`, `start_time`, `end_time` per employee.
- **Time Logs:** Employee clocks in/out. System computes `work_hours = (check_out - check_in)`.
- Employees have read-only visibility into their assigned dates.

### 6.2 Cash Drawer (Shift) Management
- **Open Shift:** Staff records opening cash float (e.g., 2,000 THB).
- **Transactions:** Orders link to `shift_id`.
- **Close Shift:** Staff inputs actual counted cash. System auto-evaluates:
  $$\text{Cash Discrepancy} = \text{Actual Cash} - (\text{Initial Cash} + \text{Total Cash Sales})$$
- Highlights shortages or overages for Admin review.

---

## 7. PostgreSQL Database Schema

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enums
CREATE TYPE user_role AS ENUM ('member', 'employee', 'admin');
CREATE TYPE order_type AS ENUM ('pos_walkin', 'preorder');
CREATE TYPE order_status AS ENUM (
    'pending', 
    'confirmed', 
    'ready_for_pickup', 
    'completed', 
    'cancelled'
);
CREATE TYPE payment_method AS ENUM ('cash', 'promptpay', 'points', 'mixed');
CREATE TYPE stock_movement_type AS ENUM (
    'manual_adjust', 
    'pos_sale', 
    'preorder_reserve', 
    'preorder_cancel', 
    'restock'
);
CREATE TYPE shift_status AS ENUM ('open', 'closed');

-- Users
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE,
    phone VARCHAR(20) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    role user_role NOT NULL DEFAULT 'member',
    points_balance INT NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Categories & Products
CREATE TABLE categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    category_id INT REFERENCES categories(id) ON DELETE SET NULL,
    barcode VARCHAR(64) UNIQUE,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    cost_price NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    sale_price NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    stock_qty INT NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
    reserved_qty INT NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
    image_url TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_stock_availability CHECK (stock_qty >= reserved_qty)
);

CREATE TABLE stock_logs (
    id BIGSERIAL PRIMARY KEY,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    changed_by UUID NOT NULL REFERENCES users(id),
    movement_type stock_movement_type NOT NULL,
    qty_changed INT NOT NULL,
    balance_after INT NOT NULL,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Schedules & Shifts
CREATE TABLE work_schedules (
    id SERIAL PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shift_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    note TEXT,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_employee_shift_date UNIQUE (employee_id, shift_date)
);

CREATE TABLE time_logs (
    id SERIAL PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    check_in TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    check_out TIMESTAMPTZ,
    work_hours NUMERIC(5, 2) GENERATED ALWAYS AS (
        ROUND(EXTRACT(EPOCH FROM (check_out - check_in)) / 3600.0, 2)
    ) STORED,
    note TEXT
);

CREATE TABLE cash_shifts (
    id SERIAL PRIMARY KEY,
    opened_by UUID NOT NULL REFERENCES users(id),
    closed_by UUID REFERENCES users(id),
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    initial_cash NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    expected_cash NUMERIC(10, 2),
    actual_cash NUMERIC(10, 2),
    status shift_status NOT NULL DEFAULT 'open'
);

-- Orders
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_number VARCHAR(30) UNIQUE NOT NULL,
    order_type order_type NOT NULL DEFAULT 'pos_walkin',
    status order_status NOT NULL DEFAULT 'pending',
    customer_id UUID REFERENCES users(id) ON DELETE SET NULL,
    cashier_id UUID REFERENCES users(id) ON DELETE SET NULL,
    pickup_pin VARCHAR(6),
    subtotal_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    discount_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    final_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    points_earned INT NOT NULL DEFAULT 0,
    points_redeemed INT NOT NULL DEFAULT 0,
    cancel_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_at TIMESTAMPTZ,
    ready_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ
);

CREATE TABLE order_items (
    id BIGSERIAL PRIMARY KEY,
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id),
    unit_price NUMERIC(10, 2) NOT NULL,
    unit_cost NUMERIC(10, 2) NOT NULL,
    quantity INT NOT NULL CHECK (quantity > 0),
    total_price NUMERIC(10, 2) NOT NULL
);

CREATE TABLE payments (
    id SERIAL PRIMARY KEY,
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    shift_id INT REFERENCES cash_shifts(id) ON DELETE SET NULL,
    method payment_method NOT NULL,
    amount NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
    received_amount NUMERIC(10, 2),
    change_amount NUMERIC(10, 2),
    transaction_ref VARCHAR(100),
    paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE point_transactions (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    points_change INT NOT NULL,
    balance_after INT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Performance Indexes
CREATE INDEX idx_products_barcode ON products(barcode);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at);
CREATE INDEX idx_time_logs_employee ON time_logs(employee_id, check_in);
```

---

## 8. Excel Export Specification

The system must provide an endpoint `GET /api/v1/reports/export?type={report_type}&from={date}&to={date}`:

1. **Daily & Monthly Sales Summary (`sales_summary`):**
   - Columns: `Order ID`, `Date/Time`, `Type (POS/Online)`, `Subtotal`, `Discount`, `Net Total`, `Payment Method`, `Cashier Name`.
2. **Product Sales & Margin (`product_performance`):**
   - Columns: `Barcode`, `Product Name`, `Quantity Sold`, `Total Revenue`, `Total Cost`, `Gross Profit Margin (%)`.
3. **Staff Timesheet Report (`employee_attendance`):**
   - Columns: `Employee ID`, `Name`, `Date`, `Scheduled In`, `Scheduled Out`, `Actual Check-In`, `Actual Check-Out`, `Total Hours Worked`, `Lateness/Overtime`.
4. **Stock Movement Audit Log (`stock_audit`):**
   - Columns: `Timestamp`, `Product Name`, `Adjustment Type`, `Quantity Delta`, `Ending Stock`, `Adjusted By`, `Reason/Note`.