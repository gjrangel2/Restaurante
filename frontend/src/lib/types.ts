// Contratos compartidos con el backend (ver backend/src/modules/*.service.ts).

export type StaffRole = 'ADMIN' | 'WAITER' | 'KITCHEN';

export interface StaffUser {
  id: string;
  name: string;
  role: StaffRole;
}

export interface RestaurantInfo {
  name: string;
  currency: string;
  suggestedTipRate: number;
  taxName?: string;
  taxRate?: number;
  pricesIncludeTax?: boolean;
}

// --- Mapa de sala -----------------------------------------------------------

/** Los 5 estados exactos del mapa del restaurante. */
export type TableStatus = 'FREE' | 'OCCUPIED' | 'WAITING_ORDER' | 'SERVED' | 'CALLING';
export type TableShape = 'ROUND' | 'SQUARE' | 'RECT';
export type CallType = 'WAITER' | 'BILL';

export interface TableSessionSummary {
  id: string;
  openedAt: string;
  guests: number;
  pendingOrders: number;
  readyOrders: number;
  total: number;
  call: null | { id: string; type: CallType; createdAt: string; guestAlias: string | null };
}

export interface RestaurantTable {
  id: string;
  number: number;
  seats: number;
  zone: string;
  shape: TableShape;
  posX: number;
  posY: number;
  status: TableStatus;
  statusChangedAt: string;
  session: TableSessionSummary | null;
}

// --- Comandas ---------------------------------------------------------------

export type OrderStatus = 'PENDING' | 'CONFIRMED' | 'PREPARING' | 'READY' | 'SERVED' | 'CANCELLED';
export type ItemStatus = 'PENDING' | 'PREPARING' | 'READY' | 'SERVED' | 'CANCELLED';

export interface OrderItem {
  id: string;
  productId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  notes: string;
  guestAlias: string | null;
  status: ItemStatus;
}

export interface Order {
  id: string;
  number: number;
  status: OrderStatus;
  tableId: string;
  tableNumber: number;
  sessionId: string;
  createdAt: string;
  confirmedAt: string | null;
  readyAt: string | null;
  servedAt: string | null;
  total: number;
  items: OrderItem[];
}

// --- Cuenta y factura -------------------------------------------------------

export interface BillTotals {
  gross: number;
  subtotal: number;
  taxName: string;
  taxRate: number;
  taxTotal: number;
  tipRate: number;
  tipTotal: number;
  grandTotal: number;
}

export interface BillPreview {
  totals: BillTotals;
  suggestedTipRate: number;
  currency: string;
  canCharge: boolean;
  ordersInProgress: number;
}

export type PaymentMethod = 'CASH' | 'CARD' | 'TRANSFER';

export interface Invoice {
  id: string;
  invoiceNumber: string;
  tableNumber: number;
  subtotal: number;
  taxName: string;
  taxRate: number;
  taxTotal: number;
  tipTotal: number;
  grandTotal: number;
  customerName: string;
  customerDoc: string;
  cufe: string;
  issuedAt: string;
  payment: { method: PaymentMethod; amountReceived: number; changeDue: number; reference: string };
  simulated: boolean;
}

export interface TableDetail {
  table: RestaurantTable;
  orders: Order[];
  guests: Guest[];
  bill: BillPreview | null;
}

// --- App del cliente --------------------------------------------------------

export interface Guest {
  id: string;
  number: number; // orden de llegada a la mesa: 1, 2, 3…
  alias: string; // "Cliente #1"
  color: string;
  online?: boolean;
}

export interface Product {
  id: string;
  categoryId: string;
  categoryName?: string;
  name: string;
  description: string;
  price: number;
  imageUrl: string | null;
  isAvailable: boolean;
  isFeatured: boolean;
  prepMinutes: number;
  tags: string[];
  sortOrder: number;
}

export interface MenuCategory {
  id: string;
  name: string;
  products: Product[];
}

export interface Promotion {
  id: string;
  title: string;
  subtitle: string;
  imageUrl: string | null;
  productId: string | null;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
}

export interface PublicMenu {
  restaurant: RestaurantInfo;
  categories: MenuCategory[];
  promotions: Promotion[];
}

export interface CartLine {
  id: string;
  productId: string;
  name: string;
  unitPrice: number;
  imageUrl: string | null;
  quantity: number;
  notes: string;
  isAvailable: boolean;
  guest: Guest;
}

export interface Cart {
  items: CartLine[];
  totalQuantity: number;
  subtotal: number;
}

export interface CartChange {
  by: { id: string; alias: string };
  action: 'added' | 'updated' | 'removed' | 'ordered';
  productName?: string;
}

export type JoinResponse =
  | { state: 'CLOSED'; restaurant: RestaurantInfo; table: { id: string; number: number; zone: string } }
  | { state: 'OPEN'; restaurant: RestaurantInfo; table: { id: string; number: number; zone: string }; token: string; guest: Guest };

export interface GuestState {
  me: Guest;
  cart: Cart;
  orders: Order[];
  guests: Guest[];
  openCalls: CallType[];
}

// --- Administración ---------------------------------------------------------

export interface InventoryItem {
  id: string;
  name: string;
  unit: 'g' | 'ml' | 'und';
  stock: number;
  reorderLevel: number;
  avgDailyUsage: number;
  daysOfCover: number | null;
  alertLevel: 'RED' | 'YELLOW' | 'OK';
  affectedProducts: string[];
}

export interface ProductSales {
  id: string;
  name: string;
  category: string;
  imageUrl: string | null;
  units: number;
  revenue: number;
}

export interface Kpis {
  currency: string;
  periodDays: number;
  salesToday: number;
  ticketsToday: number;
  avgTicketToday: number;
  salesYesterday: number;
  salesYesterdaySameTime: number; // ayer, acumulado hasta esta misma hora
  avgTicketYesterday: number;
  openTables: number;
  totalTables: number;
  openAmount: number;
  daily: Array<{ day: string; sales: number; tickets: number }>;
  topProducts: ProductSales[];
  bottomProducts: ProductSales[];
}

export interface Category {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  productCount: number;
}
