// Contratos compartidos con el backend (ver backend/src/modules/*.service.ts).

export type StaffRole = 'ADMIN' | 'WAITER' | 'KITCHEN' | 'COURIER';

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
  lateGuests: Array<{ id: string; alias: string; color: string; joinedAt: string }>;
  payingOnline: boolean;
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

export type OrderChannel = 'DINE_IN' | 'DELIVERY' | 'PICKUP';

export interface Order {
  id: string;
  number: number;
  status: OrderStatus;
  channel: OrderChannel;
  tableId: string | null;
  tableNumber: number | null;
  sessionId: string | null;
  deliveryId: string | null;
  deliveryCode: string | null;
  customerName: string | null;
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
  onlinePayment: null | { id: string; channel: string; expiresAt: string };
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
  | { state: 'OPEN'; restaurant: RestaurantInfo; table: { id: string; number: number; zone: string }; token: string; guest: Guest; joinedLate?: boolean };

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

// --- Mapa y pagos en línea --------------------------------------------------

export interface MapConfig {
  tileUrl: string;
  attribution: string;
}

export type PaymentChannel = 'WOMPI' | 'MERCADOPAGO' | 'PSE';

export interface PaymentOption {
  id: PaymentChannel;
  label: string;
  detail: string;
  live: boolean; // false = pasarela de pruebas
  via?: 'WOMPI' | 'MERCADOPAGO';
}

export type IntentStatus = 'PENDING' | 'APPROVED' | 'DECLINED' | 'ERROR' | 'EXPIRED';

export interface PaymentIntentView {
  reference: string;
  status: IntentStatus;
  purpose: 'DELIVERY' | 'TABLE_BILL';
  channel: PaymentChannel;
  live: boolean;
  amount: number;
  currency: string;
  expiresAt: string;
  description: string;
  restaurantName: string;
  trackingCode: string | null;
  tableNumber: number | null;
  invoiceNumber: string | null;
  needsReview: boolean;
}

// --- Domicilios -------------------------------------------------------------

export type DeliveryStatus = 'PENDING_PAYMENT' | 'PLACED' | 'ACCEPTED' | 'PREPARING' | 'READY' | 'ON_THE_WAY' | 'DELIVERED' | 'CANCELLED';
export type DeliveryPayment = 'CASH' | 'CARD_ON_DELIVERY' | 'ONLINE';
export type Vehicle = 'MOTO' | 'BICI' | 'CARRO';

export interface DeliveryZone {
  name: string;
  maxKm: number;
  fee: number;
  travelMinutes: number;
}

export interface DeliveryConfig {
  restaurant: {
    name: string;
    address: string | null;
    phone: string | null;
    lat: number | null;
    lng: number | null;
    currency: string;
    taxName: string;
    taxRate: number;
    pricesIncludeTax: boolean;
    deliveryEnabled: boolean;
    pickupEnabled: boolean;
    minOrder: number;
    prepMinutes: number;
  };
  zones: DeliveryZone[];
  payments: PaymentOption[];
  map: MapConfig;
}

export interface DeliveryQuote {
  inCoverage: boolean;
  distanceKm: number;
  zone: (DeliveryZone & { id: string }) | null;
  fee: number;
  etaMinutes: number;
  maxKm: number;
}

export interface CourierSummary {
  id: string;
  name: string;
  phone: string;
  vehicle: Vehicle;
  plate: string | null;
  lat: number | null;
  lng: number | null;
  lastSeenAt: string | null;
}

export interface Courier extends CourierSummary {
  isAvailable: boolean;
  active: number;
  deliveredToday: number;
}

export interface Delivery {
  id: string;
  code: string;
  orderId: string;
  orderNumber: number;
  type: 'DELIVERY' | 'PICKUP';
  status: DeliveryStatus;
  createdAt: string;
  placedAt: string | null;
  acceptedAt: string | null;
  readyAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  estimatedAt: string | null;
  customerName: string;
  customerPhone: string;
  addressLine: string | null;
  addressDetails: string | null;
  addressNotes: string | null;
  lat: number | null;
  lng: number | null;
  distanceKm: number | null;
  zoneName: string | null;
  subtotal: number;
  deliveryFee: number;
  total: number;
  paymentMethod: DeliveryPayment;
  paid: boolean;
  refundPending: boolean;
  courier: CourierSummary | null;
  items: Array<{ name: string; quantity: number; unitPrice: number; notes: string; status: string }>;
}

export interface Tracking {
  code: string;
  type: 'DELIVERY' | 'PICKUP';
  status: DeliveryStatus;
  trackingCode: string;
  pin: string;
  createdAt: string;
  placedAt: string | null;
  acceptedAt: string | null;
  readyAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  estimatedAt: string | null;
  etaMinutes: number | null;
  customerName: string;
  addressLine: string | null;
  addressDetails: string | null;
  lat: number | null;
  lng: number | null;
  subtotal: number;
  deliveryFee: number;
  total: number;
  paymentMethod: DeliveryPayment;
  paid: boolean;
  refundPending: boolean;
  items: Array<{ name: string; quantity: number; unitPrice: number; notes: string }>;
  restaurant: { name: string; address: string | null; phone: string | null; lat: number | null; lng: number | null; currency: string };
  courier: { name: string; vehicle: Vehicle; plate: string | null; phone: string; lat: number | null; lng: number | null; lastSeenAt: string | null } | null;
  track: Array<[number, number]>;
}

export interface DeliverySettings {
  deliveryEnabled: boolean;
  pickupEnabled: boolean;
  minOrder: number;
  prepMinutes: number;
  address: string | null;
  phone: string | null;
  lat: number | null;
  lng: number | null;
  zones: DeliveryZone[];
}
