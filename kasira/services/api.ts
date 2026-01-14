
import { User, Role, Branch, Product, Transaction, FinancialStats, Category, BranchPerformance, AccountStatus, PaymentStatus, PaymentRecord } from '../types';
import { realtime } from './realtime';
import { GoogleGenAI } from "@google/genai";

const DB_PREFIX = 'kasira_db_';
const save = (key: string, data: any) => localStorage.setItem(DB_PREFIX + key, JSON.stringify(data));
const load = (key: string, fallback: any) => {
  const data = localStorage.getItem(DB_PREFIX + key);
  return data ? JSON.parse(data) : fallback;
};

// Fix: Initialize users from localStorage or default
let users: User[] = load('users', [
  { id: 'u1', name: 'Budi Hartono', email: 'owner@kasira.com', role: Role.OWNER, businessName: 'Kasira Retail Group', status: AccountStatus.ACTIVE, packageType: 'Pro', expiredAt: '2026-12-31T23:59:59Z' },
  { id: 'u2', name: 'Andi Pratama', email: 'kasir@kasira.com', role: Role.KASIR, branchId: 'b1' }
]);

let registrationPayments: PaymentRecord[] = load('reg_payments', []);
let pendingRegistrations: Record<string, any> = load('pending_regs', {});

const uuid = () => Math.random().toString(36).substr(2, 9).toUpperCase();

export const api = {
  login: async (email: string) => {
    const user = users.find(u => u.email === email);
    if (!user) return null;
    
    // Check Subscription Status
    if (user.role === Role.OWNER && user.expiredAt) {
      if (new Date(user.expiredAt) < new Date()) {
        user.status = AccountStatus.EXPIRED;
        save('users', users);
      }
    }
    return user;
  },

  /**
   * MIDTRANS REGISTRATION FLOW
   */
  initiateRegistration: async (data: any) => {
    await new Promise(r => setTimeout(r, 800));
    const orderId = `REG-${uuid()}`;
    const amount = data.package === 'Pro' ? 199000 : 1900000;
    
    // Simpan data pendaftaran ke temporary storage (Laravel: Cache/Pending Table)
    pendingRegistrations[orderId] = data;
    save('pending_regs', pendingRegistrations);

    const payment: PaymentRecord = {
      orderId,
      amount,
      paymentType: data.payment === 'QRIS' ? 'qris' : 'va',
      status: 'pending'
    };

    if (data.payment === 'QRIS') {
      payment.qrisUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=KASIRA-SUBS-${orderId}`;
    } else {
      payment.bank = 'MANDIRI';
      payment.vaNumber = `88920${Math.floor(100000000 + Math.random() * 900000000)}`;
    }

    registrationPayments.push(payment);
    save('reg_payments', registrationPayments);
    return payment;
  },

  /**
   * MIDTRANS CALLBACK FOR REGISTRATION (Laravel: /api/midtrans/register-callback)
   */
  handleRegistrationCallback: async (orderId: string, status: 'paid' | 'failed') => {
    await new Promise(r => setTimeout(r, 1000));
    
    const payIdx = registrationPayments.findIndex(p => p.orderId === orderId);
    if (payIdx === -1) throw new Error("Order ID tidak ditemukan");
    
    const payment = registrationPayments[payIdx];
    if (payment.status !== 'pending') return; // Prevent double callback

    payment.status = status;
    save('reg_payments', registrationPayments);

    if (status === 'paid') {
      const regData = pendingRegistrations[orderId];
      if (!regData) throw new Error("Data pendaftaran kadaluarsa");

      // ATOMIC TRANSACTION: Create User + Subscription
      const newUser: User = {
        id: uuid(),
        name: regData.name,
        email: regData.email,
        role: Role.OWNER,
        businessName: regData.businessName,
        packageType: regData.package,
        status: AccountStatus.ACTIVE,
        expiredAt: new Date(Date.now() + (regData.package === 'Pro' ? 30 : 365) * 24 * 60 * 60 * 1000).toISOString()
      };

      users.push(newUser);
      save('users', users);
      
      // Cleanup
      delete pendingRegistrations[orderId];
      save('pending_regs', pendingRegistrations);

      return newUser;
    }
    return null;
  },

  /**
   * DIRECT REGISTRATION FOR TRIAL
   */
  registerTrial: async (data: any) => {
    await new Promise(r => setTimeout(r, 500));
    
    // DB::transaction
    const newUser: User = {
      id: uuid(),
      name: data.name,
      email: data.email,
      role: Role.OWNER,
      businessName: data.businessName,
      packageType: 'Trial',
      status: AccountStatus.TRIAL,
      expiredAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    };

    users.push(newUser);
    save('users', users);
    return newUser;
  },

  getBranches: async (ownerId: string) => load('branches', []).filter((b: Branch) => b.ownerId === ownerId),

  // Fix: Added missing addBranch method
  addBranch: async (data: any) => {
    const branches = load('branches', []);
    const newBranch = { ...data, id: uuid() };
    branches.push(newBranch);
    save('branches', branches);
    return newBranch;
  },

  // Fix: Added missing deleteBranch method
  deleteBranch: async (id: string, role: Role) => {
    if (role !== Role.OWNER) throw new Error("Unauthorized");
    let branches = load('branches', []);
    branches = branches.filter((b: Branch) => b.id !== id);
    save('branches', branches);
    return { success: true };
  },

  getProducts: async (branchId?: string) => {
    const p = load('products', []);
    if (branchId && branchId !== 'all') return p.filter((item: Product) => item.branchId === branchId);
    return p;
  },

  // Fix: Added missing addProduct method
  addProduct: async (data: any) => {
    const products = load('products', []);
    const newProduct = { 
      ...data, 
      id: uuid(), 
      price: Number(data.price), 
      costPrice: Number(data.costPrice), 
      stock: Number(data.stock),
      imageUrl: data.imageUrl || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=500'
    };
    products.push(newProduct);
    save('products', products);
    return newProduct;
  },

  // Fix: Added missing updateProduct method
  updateProduct: async (id: string, data: any, role: Role) => {
    if (role !== Role.OWNER) throw new Error("Unauthorized");
    const products = load('products', []);
    const idx = products.findIndex((p: Product) => p.id === id);
    if (idx === -1) throw new Error("Product not found");
    products[idx] = { ...products[idx], ...data, price: Number(data.price), costPrice: Number(data.costPrice), stock: Number(data.stock) };
    save('products', products);
    return products[idx];
  },

  // Fix: Added missing deleteProduct method
  deleteProduct: async (id: string, role: Role) => {
    if (role !== Role.OWNER) throw new Error("Unauthorized");
    let products = load('products', []);
    products = products.filter((p: Product) => p.id !== id);
    save('products', products);
    return { success: true };
  },

  // Fix: Added missing getCategories method
  getCategories: async () => {
    return load('categories', [
      { id: 'c1', name: 'Makanan', branchId: 'all' },
      { id: 'c2', name: 'Minuman', branchId: 'all' }
    ]);
  },

  // Fix: Implemented financial report calculations
  getFinancialReport: async (filters: any) => {
    let tx = load('transactions', []).filter((t: Transaction) => t.status === 'success');
    
    if (filters.branchId && filters.branchId !== 'all') {
      tx = tx.filter((t: Transaction) => t.branchId === filters.branchId);
    }
    if (filters.startDate) {
      tx = tx.filter((t: Transaction) => new Date(t.date) >= new Date(filters.startDate));
    }
    if (filters.endDate) {
      tx = tx.filter((t: Transaction) => new Date(t.date) <= new Date(filters.endDate));
    }

    const stats = tx.reduce((acc, t) => {
      const cogs = t.items.reduce((sum, i) => sum + (i.cost_snapshot * i.quantity), 0);
      acc.revenue += t.subtotal;
      acc.cogs += cogs;
      acc.totalDiscount += (t.discount || 0);
      acc.totalTax += (t.tax || 0);
      acc.orderCount += 1;
      return acc;
    }, { revenue: 0, cogs: 0, grossProfit: 0, netProfit: 0, totalDiscount: 0, totalTax: 0, orderCount: 0 });

    stats.grossProfit = stats.revenue - stats.cogs;
    stats.netProfit = stats.grossProfit - stats.totalDiscount;

    return { transactions: tx, stats };
  },

  // Fix: Added missing getBranchComparison method
  getBranchComparison: async (ownerId: string, startDate?: string, endDate?: string) => {
    const branches = load('branches', []).filter((b: Branch) => b.ownerId === ownerId);
    const transactions = load('transactions', []).filter((t: Transaction) => t.status === 'success');
    
    const start = startDate ? new Date(startDate) : new Date(0);
    const end = endDate ? new Date(endDate) : new Date();

    return branches.map((b: Branch) => {
      const branchTx = transactions.filter((t: Transaction) => 
        t.branchId === b.id && 
        new Date(t.date) >= start && 
        new Date(t.date) <= end
      );

      const stats = branchTx.reduce((acc, t) => {
        const cogs = t.items.reduce((sum, i) => sum + (i.cost_snapshot * i.quantity), 0);
        acc.revenue += t.subtotal;
        acc.cogs += cogs;
        acc.totalDiscount += (t.discount || 0);
        acc.totalTax += (t.tax || 0);
        acc.orderCount += 1;
        
        t.items.forEach(item => {
           acc.productSales[item.name] = (acc.productSales[item.name] || 0) + item.quantity;
        });

        return acc;
      }, { revenue: 0, cogs: 0, totalDiscount: 0, totalTax: 0, orderCount: 0, productSales: {} as Record<string, number> });

      const grossProfit = stats.revenue - stats.cogs;
      const netProfit = grossProfit - stats.totalDiscount;

      // Find best seller
      let bestSeller = 'N/A';
      let maxSales = 0;
      Object.entries(stats.productSales).forEach(([name, sales]) => {
        if (sales > maxSales) {
          maxSales = sales;
          bestSeller = name;
        }
      });

      return {
        branchId: b.id,
        branchName: b.name,
        revenue: stats.revenue,
        cogs: stats.cogs,
        grossProfit,
        netProfit,
        totalDiscount: stats.totalDiscount,
        totalTax: stats.totalTax,
        orderCount: stats.orderCount,
        bestSeller,
        trend: 'stable' as const
      };
    });
  },

  // Fix: Added missing getAIAnalysis method using Gemini API
  getAIAnalysis: async (data: any) => {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const prompt = `Anda adalah konsultan bisnis profesional untuk aplikasi KASIRA. 
    Analisis data performa bisnis UMKM berikut dan berikan 3-4 poin saran strategis yang singkat, padat, dan berorientasi pada hasil (actionable).
    
    Data Periode: ${data.period}
    Statistik: Omzet Rp${data.stats.revenue.toLocaleString()}, Laba Bersih Rp${data.stats.netProfit.toLocaleString()}, Total Transaksi ${data.stats.orderCount}.
    Cabang Terbaik: ${data.branches[0]?.branchName || 'N/A'} (Best Seller: ${data.branches[0]?.bestSeller || 'N/A'}).
    Jumlah Produk: ${data.products.length}.

    Berikan analisis dalam Bahasa Indonesia yang profesional dan memotivasi. Gunakan format poin-poin.`;

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3-pro-preview',
        contents: prompt,
      });
      return response.text || "Gagal mendapatkan analisis AI saat ini.";
    } catch (error) {
      console.error("AI Analysis Error:", error);
      return "Maaf, asisten AI sedang sibuk. Silakan coba beberapa saat lagi.";
    }
  },

  // Fix: Added missing getStaff method
  getStaff: async (ownerId: string) => {
    const branches = load('branches', []).filter((b: Branch) => b.ownerId === ownerId);
    const branchIds = branches.map((b: Branch) => b.id);
    return users.filter(u => u.role === Role.KASIR && u.branchId && branchIds.includes(u.branchId));
  },

  // Fix: Added missing addStaff method
  addStaff: async (data: any) => {
    const newUser: User = {
      id: uuid(),
      name: data.name,
      email: data.email,
      role: Role.KASIR,
      branchId: data.branchId,
      status: AccountStatus.ACTIVE
    };
    users.push(newUser);
    save('users', users);
    return newUser;
  },

  // Fix: Added missing deleteStaff method
  deleteStaff: async (id: string, role: Role) => {
    if (role !== Role.OWNER) throw new Error("Unauthorized");
    users = users.filter(u => u.id !== id);
    save('users', users);
    return { success: true };
  },

  // Fix: Added missing createTransaction method
  createTransaction: async (data: any) => {
    const products = load('products', []);
    const transactions = load('transactions', []);
    
    const items = data.items.map((item: any) => {
      const p = products.find((prod: Product) => prod.id === item.productId);
      if (!p) throw new Error(`Product ${item.productId} not found`);
      if (p.stock < item.quantity) throw new Error(`Insufficient stock for ${p.name}`);
      
      p.stock -= item.quantity;
      
      return {
        productId: p.id,
        name: p.name,
        quantity: item.quantity,
        price_snapshot: p.price,
        cost_snapshot: p.costPrice
      };
    });

    save('products', products);

    const subtotal = items.reduce((acc: number, i: any) => acc + (i.price_snapshot * i.quantity), 0);
    const total = subtotal + (data.tax || 0) - (data.discount || 0);

    const newTx: Transaction = {
      id: `TX-${uuid()}`,
      branchId: data.branchId,
      cashierId: data.cashierId,
      subtotal,
      tax: data.tax || 0,
      discount: data.discount || 0,
      total,
      status: data.paymentMethod === 'CASH' ? 'success' : 'pending',
      paymentMethod: data.paymentMethod,
      date: new Date().toISOString(),
      items,
      paymentDetails: {}
    };

    if (data.paymentMethod === 'TRANSFER') {
      newTx.paymentDetails = {
        bank: data.bank,
        va_number: `88000${Math.floor(10000000 + Math.random() * 90000000)}`,
        midtrans_order_id: `MID-${uuid()}`
      };
    } else if (data.paymentMethod === 'QRIS') {
      newTx.paymentDetails = {
        qris_url: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=KASIRA-TX-${newTx.id}`,
        midtrans_order_id: `MID-${uuid()}`
      };
    }

    transactions.push(newTx);
    save('transactions', transactions);

    const branch = load('branches', []).find((b: Branch) => b.id === data.branchId);
    if (branch) {
      realtime.broadcast(`owner.${branch.ownerId}`, 'TransactionCreated', newTx);
    }
    realtime.broadcast(`branch.${data.branchId}`, 'StockUpdated', {});

    return newTx;
  },

  // Fix: Added missing simulateMidtransCallback method
  simulateMidtransCallback: async (transactionId: string, status: PaymentStatus) => {
    const transactions = load('transactions', []);
    const txIdx = transactions.findIndex((t: Transaction) => t.id === transactionId);
    if (txIdx === -1) return;

    transactions[txIdx].status = status;
    save('transactions', transactions);

    realtime.broadcast(`branch.${transactions[txIdx].branchId}`, 'PaymentStatusUpdated', {
      status,
      transactionId
    });

    if (status === 'success') {
      const branch = load('branches', []).find((b: Branch) => b.id === transactions[txIdx].branchId);
      if (branch) {
        realtime.broadcast(`owner.${branch.ownerId}`, 'TransactionCreated', transactions[txIdx]);
      }
    }
  },

  // Fix: Added missing getTransactions method
  getTransactions: async (branchId: string) => {
    const tx = load('transactions', []);
    return tx.filter((t: Transaction) => t.branchId === branchId);
  },

  // Fix: Added missing adjustStock method
  adjustStock: async (productId: string, amount: number, note: string) => {
    const products = load('products', []);
    const idx = products.findIndex((p: Product) => p.id === productId);
    if (idx === -1) throw new Error("Product not found");
    
    products[idx].stock += amount;
    if (products[idx].stock < 0) throw new Error("Stock cannot be negative");
    
    save('products', products);
    realtime.broadcast(`branch.${products[idx].branchId}`, 'StockUpdated', {});
    return products[idx];
  }
};
