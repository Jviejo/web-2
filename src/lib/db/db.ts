"use server";
import { Database } from 'sqlite3';
import { open } from 'sqlite';
import jwt from 'jsonwebtoken';

let db: any = null;

export async function getDb() {
    if (!db) {
        db = await open({
            filename: './northwind.db',
            driver: Database
        });
    }
    return db;
}

export async function getAllProducts() {
    const db = await getDb();
    try {
        const products = await db.all('SELECT * FROM Products');
        return products;
    } catch (error) {
        console.error('Error fetching all products:', error);
        throw error;
    }
}

export async function insertUser(username: string, password: string, acceptPolicy: boolean, acceptMarketing: boolean) {
    const db = await getDb();
    try {
        // Create the users table if it doesn't exist
        // Drop the users table if it exists
        // await db.run(`DROP TABLE IF EXISTS users`);
        await db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        acceptPolicy BOOLEAN NOT NULL,
        acceptMarketing BOOLEAN NOT NULL
      );
    `);

        // Insert sample users from Customers table
        await db.run(`
    INSERT INTO users (username, password, acceptPolicy, acceptMarketing)
      SELECT CustomerID, CustomerID, false, false FROM Customers;

    `);

        // Check if the username already exists
        const existingUser = await db.get('SELECT * FROM users WHERE username = ?', [username]);
        if (existingUser) {
            throw new Error('Username already exists');
        }

        // Insert the new user
        const result = await db.run(
            'INSERT INTO users (username, password, acceptPolicy, acceptMarketing) VALUES (?, ?, ?, ?)',
            [username, password, acceptPolicy, acceptMarketing]
        );

        return result.lastID;
    } catch (error) {
        console.error('Error inserting user:', error);
        throw error;
    }
}

export async function getUser(username: string, password: string) {
    const db = await getDb();
    try {
        const user = await db.get(
            'SELECT * FROM users WHERE username = ? AND password = ?',
            [username, password]
        );

        if (!user) {
            throw new Error('Invalid username or password');
        }

        // Compute JWT token
        
        const secret = process.env.JWT_SECRET;
        if (!secret) {
            throw new Error('JWT_SECRET is not defined in environment variables');
        }
        const token = jwt.sign(
            { 
                id: user.id, 
                username: user.username 
            },
            secret,
            { expiresIn: '1h' }
        );
        user.token = token;
        return user;
    } catch (error) {
        console.error('Error fetching user:', error);
        throw error;
    }
}

export async function getCustomer(customerId: string) {
    console.log('getCustomer', customerId);
    const db = await getDb();
    const customer = await db.get('SELECT * FROM Customers WHERE CustomerID = ?', [customerId]);
    return customer;
}

export async function saveCustomer(customerId: string, values: any) {
    console.log('saveCustomer', customerId, values);
    const db = await getDb();

    // Prepare the SQL query with all fields
    const updateQuery = `
        UPDATE Customers SET 
        CompanyName = ?,
        ContactName = ?,
        ContactTitle = ?,
        Address = ?,
        City = ?,
        Region = ?,
        PostalCode = ?,
        Country = ?,
        Phone = ?,
        Fax = ?
        WHERE CustomerID = ?
    `;

    // Extract values from the 'values' object
    const {
        CompanyName,
        ContactName,
        ContactTitle,
        Address,
        City,
        Region,
        PostalCode,
        Country,
        Phone,
        Fax
    } = values;

    // Execute the update query
    await db.run(updateQuery, [
        CompanyName,
        ContactName,
        ContactTitle,
        Address,
        City,
        Region,
        PostalCode,
        Country,
        Phone,
        Fax,
        customerId
    ]);

}

export async function getCustomerOrders(customerId: string) {
    const db = await getDb();
    try {
        const orders = await db.all(
            `SELECT OrderID, OrderDate, 
            (SELECT SUM(UnitPrice * Quantity) FROM "Order Details" WHERE OrderID = Orders.OrderID) AS TotalImporte 
            FROM Orders WHERE CustomerID = ? ORDER BY OrderDate DESC`,
            [customerId]
        );

        return orders;
    } catch (error) {
        console.error('Error fetching customer orders:', error);
        throw error;
    }
}

export async function getOrder(orderId: string) {
    const db = await getDb();
    const order = await db.get('SELECT * FROM Orders WHERE OrderID = ?', [orderId]);
    const details = await db.all(`
        SELECT od.*, p.ProductName 
        FROM "Order Details" od
        JOIN Products p ON od.ProductID = p.ProductID
        WHERE od.OrderID = ?
    `, [orderId]);
    // Compute total order amount
    const totalAmount = details.reduce((sum: number, detail: any) => {
        return sum + (detail.UnitPrice * detail.Quantity * (1 - detail.Discount));
    }, 0);

    // Add details and total amount to the order object
    order.Details = details;
    order.TotalAmount = parseFloat(totalAmount.toFixed(2));
    return order;
}

export async function getProduct(productId: string) {
    const db = await getDb();
    const product = await db.get('SELECT * FROM Products WHERE ProductID = ?', [productId]);
    return product;
}

export async function cesta(productId: string, username: string, cantidad: number) {
    const db = await getDb();
    try {
        // Create the 'cesta' table if it doesn't exist
        await db.run(`
            CREATE TABLE IF NOT EXISTS cesta (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                productId INTEGER NOT NULL,
                username TEXT NOT NULL,
                cantidad INTEGER NOT NULL,
                UNIQUE(productId, username)
            )
        `);
        
        // Insert or update the quantity in the 'cesta' table
        await db.run(`
            INSERT INTO cesta (productId, username, cantidad)
            VALUES (:productId, :username, :cantidad)
            ON CONFLICT(productId, username) DO UPDATE SET
            cantidad =  :cantidad
        `, { 
            ':productId': productId, 
            ':username': username, 
            ':cantidad': cantidad 
        });

    } catch (error) {
        console.error('Error updating cesta:', error);
        throw error;
    }
}

export async function getCesta(username: string) {
    const db = await getDb();
    try {
        // Fetch items from the 'cesta' table for the given username
        const cestaItems = await db.all(`
            SELECT c.productId, p.productName, c.cantidad
            FROM cesta c
            JOIN Products p ON c.productId = p.ProductID
            WHERE c.username = ?
        `, [username]);

        return cestaItems;
    } catch (error) {
        console.error('Error fetching cesta:', error);
        throw error;
    }
}

export async function createOrder(username: string, idCesta: string) {
    const db = await getDb();
    try {
        await db.run('BEGIN TRANSACTION');

        // Get CustomerId from the username
        const customer = await db.get('SELECT CustomerID FROM Customers WHERE CustomerID = ?', 
            [username]);
        if (!customer) {
            throw new Error('Customer not found');
        }

        // Insert into Orders table
        const orderDate = new Date().toISOString();
        const result = await db.run(`
            INSERT INTO Orders (CustomerID, OrderDate)
            VALUES (?, ?)
        `, [customer.CustomerID, orderDate]);

        const orderId = result.lastID;

        // Get cesta items
        const cestaItems = await db.all(`
            SELECT c.productId, c.cantidad, p.UnitPrice
            FROM cesta c
            JOIN Products p ON c.productId = p.ProductID
            WHERE c.username = ?
        `, [idCesta]);

        // Insert into Order Details
        for (const item of cestaItems) {
            await db.run(`
                INSERT INTO "Order Details" (OrderID, ProductID, UnitPrice, Quantity, Discount)
                VALUES (?, ?, ?, ?, 0)
            `, [orderId, item.productId, item.UnitPrice, item.cantidad]);
        }

        // Compute total order amount
        const totalResult = await db.get(`
            SELECT SUM(UnitPrice * Quantity) as TotalAmount
            FROM "Order Details"
            WHERE OrderID = ?
        `, [orderId]);

        const totalAmount = totalResult.TotalAmount;
        // Clear the cesta
        await db.run('DELETE FROM cesta WHERE username = ?', [idCesta]);

        await db.run('COMMIT');

        return {orderId, totalAmount};
    } catch (error) {
        await db.run('ROLLBACK');
        console.error('Error creating order:', error);
        throw error;
    }
}

export async function saveCobro(customerId: string, orderId: number, amount: number, authorizationCode: string) {
    const db = await getDb();
    try {
        // Drop the cobro table if it exists
        // await db.run(`DROP TABLE IF EXISTS cobro`);
        // Create the cobro table if it doesn't exist
        await db.run(`
            CREATE TABLE IF NOT EXISTS cobro (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                orderId INTEGER NOT NULL,
                customerId TEXT NOT NULL,
                amount REAL NOT NULL,
                authorizationCode TEXT NOT NULL UNIQUE,
                fecha TEXT NOT NULL
            )
        `);

        // Insert the new cobro
        const fecha = new Date().toISOString();
        const result = await db.run(
            'INSERT INTO cobro (orderId, customerId, amount, fecha, authorizationCode) VALUES (?, ?, ?, ?, ?)',
            [orderId, customerId, amount, fecha, authorizationCode]
        );

        return result.lastID;
    } catch (error) {
        console.error('Error saving cobro:', error);
        throw error;
    }
}