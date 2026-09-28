const path = require("path");

try {
    process.loadEnvFile(path.join(__dirname, ".env"));
} catch {
    // No .env — the defaults below are used instead.
}

const express = require("express");
const mysql = require("mysql2/promise");

if (!process.env.DB_PASSWORD) {
    console.error("DB_PASSWORD is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
}

const app = express();
const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === "production";

// Must match the column widths in student_db.sql.
const MAX_NAME_LENGTH = 100;
const MAX_COURSE_LENGTH = 50;
const MAX_YEAR_LEVEL = 6;

// Ids are 8 digits: 2-digit year added + a 6-digit counter that resets each
// year, so the first student of 2026 is 26000001 and the first of 2027 is 27000001.
const ID_PER_YEAR = 1_000_000;
const ID_COUNTER_MAX = 999_999;
const ID_LOCK = "students_id_alloc";

// Inclusive id range for a year, defaulting to the current one.
function idRange(year = new Date().getFullYear()) {
    const prefix = (year % 100) * ID_PER_YEAR;
    return { year, first: prefix + 1, last: prefix + ID_COUNTER_MAX };
}

// Connection settings come from .env (see .env.example). Defaults are generic
// so no credentials live in the source.
const pool = mysql.createPool({
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || "student_db",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

class ApiError extends Error {
    constructor(status, code, message, details) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

// mysql2 driver error code -> [httpStatus, code, message]. Unlisted codes become 500.
const MYSQL_ERRORS = {
    ER_DUP_ENTRY: [409, "DUPLICATE_ENTRY", "A record with these values already exists"],
    ER_DATA_TOO_LONG: [422, "VALUE_TOO_LONG", "One or more values exceed the maximum allowed length"],
    ER_WARN_DATA_OUT_OF_RANGE: [422, "VALUE_OUT_OF_RANGE", "One or more numeric values are out of range"],
    ER_TRUNCATED_WRONG_VALUE_FOR_FIELD: [400, "INVALID_FIELD_VALUE", "One or more values have an invalid type"],
    ER_TRUNCATED_WRONG_VALUE: [400, "INVALID_FIELD_VALUE", "One or more values have an invalid type"],
    ER_BAD_NULL_ERROR: [400, "MISSING_FIELD", "A required column was null"],
    ER_NO_DEFAULT_FOR_FIELD: [400, "MISSING_FIELD", "A required column has no default value"],
    ER_LOCK_DEADLOCK: [503, "DB_DEADLOCK", "Database deadlock detected, please retry"],
    ER_LOCK_WAIT_TIMEOUT: [503, "DB_BUSY", "Database lock wait timed out, please retry"],
    ER_CON_COUNT_ERROR: [503, "DB_UNAVAILABLE", "Database is at its connection limit"],
    PROTOCOL_CONNECTION_LOST: [503, "DB_UNAVAILABLE", "Lost connection to the database"],
    ECONNREFUSED: [503, "DB_UNAVAILABLE", "Cannot reach the database"],
    ENOTFOUND: [503, "DB_UNAVAILABLE", "Cannot resolve the database host"],
    ETIMEDOUT: [504, "DB_TIMEOUT", "Database connection timed out"],
    PROTOCOL_SEQUENCE_TIMEOUT: [504, "DB_TIMEOUT", "Database took too long to respond"],
    ER_ACCESS_DENIED_ERROR: [500, "DB_ACCESS_DENIED", "Database rejected the configured credentials"],
    ER_BAD_DB_ERROR: [500, "DB_MISCONFIGURED", "Configured database does not exist"],
    ER_NO_SUCH_TABLE: [500, "DB_MISCONFIGURED", "Expected table is missing from the database"],
    ER_BAD_FIELD_ERROR: [500, "DB_MISCONFIGURED", "Expected column is missing from the table"],
};

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

// Serve index.html explicitly. express.static(__dirname) would also expose
// server.js and .env.
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

function parseId(raw) {
    if (!/^\d+$/.test(String(raw))) return null;
    const id = Number(raw);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Returns { student } when valid, otherwise { details: [...] }.
function parseStudent(body) {
    const details = [];

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const course = typeof body.course === "string" ? body.course.trim() : "";
    const yearLevel = Number(body.year_level ?? body.yearLevel);

    if (!name) {
        details.push({ field: "name", message: "name is required" });
    } else if (name.length > MAX_NAME_LENGTH) {
        details.push({
            field: "name",
            message: `name must be at most ${MAX_NAME_LENGTH} characters`,
        });
    }

    if (!course) {
        details.push({ field: "course", message: "course is required" });
    } else if (course.length > MAX_COURSE_LENGTH) {
        details.push({
            field: "course",
            message: `course must be at most ${MAX_COURSE_LENGTH} characters`,
        });
    }

    if (
        !Number.isInteger(yearLevel) ||
        yearLevel < 1 ||
        yearLevel > MAX_YEAR_LEVEL
    ) {
        details.push({
            field: "year_level",
            message: `year_level must be an integer between 1 and ${MAX_YEAR_LEVEL}`,
        });
    }

    return details.length ? { details } : { student: { name, course, yearLevel } };
}

function requireJson(req, res, next) {
    if (!req.is("application/json")) {
        return next(
            new ApiError(
                415,
                "UNSUPPORTED_MEDIA_TYPE",
                "Content-Type must be application/json"
            )
        );
    }
    next();
}

function methodNotAllowed(allowed) {
    return (req, res) => {
        res.set("Allow", allowed.join(", "));
        res.status(405).json({
            error: {
                code: "METHOD_NOT_ALLOWED",
                message: `${req.method} is not allowed on ${req.originalUrl}`,
                allowed,
            },
        });
    };
}

const SELECT_COLUMNS = "id, name, course, year_level";

// Express 5 forwards rejected promises to the error handler automatically.
// Every route below can also return 500/503/504 via the MYSQL_ERRORS mapping.

/**
 * GET /api/students
 * List all students, ordered by id.
 * 200 — array of students
 */
app.get("/api/students", async (req, res) => {
    const [rows] = await pool.query(
        `SELECT ${SELECT_COLUMNS} FROM students ORDER BY id`
    );
    res.status(200).json(rows);
});

/**
 * GET /api/students/:id
 * Fetch a single student.
 * 200 — the student
 * 400 — id is not a positive integer
 * 404 — no student with that id
 */
app.get("/api/students/:id", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) {
        throw new ApiError(400, "INVALID_ID", "id must be a positive integer");
    }

    const [rows] = await pool.query(
        `SELECT ${SELECT_COLUMNS} FROM students WHERE id = ?`,
        [id]
    );

    if (rows.length === 0) {
        throw new ApiError(404, "NOT_FOUND", `No student with id ${id}`);
    }

    res.status(200).json(rows[0]);
});

/**
 * POST /api/students
 * Create a student. The id is 2-digit year + a per-year counter, e.g. 26000001.
 * 201 — the created student, plus a Location header
 * 400 — validation failed
 * 409 — no ids left for the current year
 * 415 — Content-Type was not application/json
 * 503 — could not allocate an id in time
 */
app.post("/api/students", requireJson, async (req, res) => {
    // req.body is undefined in Express 5 when no parser matched.
    const { student, details } = parseStudent(req.body ?? {});

    if (details) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid student payload", details);
    }

    const { year, first, last } = idRange();
    const conn = await pool.getConnection();
    let id;

    try {
        // An advisory lock serialises id allocation. `SELECT ... FOR UPDATE` is not
        // usable here: InnoDB gap locks are mutually compatible, so concurrent
        // transactions all lock the same empty range and then deadlock on insert.
        const [[lock]] = await conn.query("SELECT GET_LOCK(?, 5) AS ok", [ID_LOCK]);
        if (!lock.ok) {
            throw new ApiError(503, "DB_BUSY", "Could not allocate a student id, please retry");
        }

        const [rows] = await conn.query(
            "SELECT id FROM students WHERE id BETWEEN ? AND ? ORDER BY id DESC LIMIT 1",
            [first, last]
        );

        id = rows.length ? rows[0].id + 1 : first;

        if (id > last) {
            throw new ApiError(409, "ID_EXHAUSTED", `No student ids left for ${year}`);
        }

        await conn.query(
            "INSERT INTO students (id, name, course, year_level) VALUES (?, ?, ?, ?)",
            [id, student.name, student.course, student.yearLevel]
        );
    } finally {
        // No-op if GET_LOCK timed out; the server also drops it if the socket dies.
        await conn.query("SELECT RELEASE_LOCK(?)", [ID_LOCK]).catch(() => {});
        conn.release();
    }

    res.status(201)
        .location(`/api/students/${id}`)
        .json({
            id,
            name: student.name,
            course: student.course,
            year_level: student.yearLevel,
        });
});

/**
 * PUT /api/students/:id
 * Replace a student.
 * 200 — the updated student
 * 400 — id is not a positive integer, or validation failed
 * 404 — no student with that id
 */
app.put("/api/students/:id", requireJson, async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) {
        throw new ApiError(400, "INVALID_ID", "id must be a positive integer");
    }

    const { student, details } = parseStudent(req.body ?? {});

    if (details) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid student payload", details);
    }

    const [result] = await pool.query(
        "UPDATE students SET name = ?, course = ?, year_level = ? WHERE id = ?",
        [student.name, student.course, student.yearLevel, id]
    );

    if (result.affectedRows === 0) {
        throw new ApiError(404, "NOT_FOUND", `No student with id ${id}`);
    }

    res.status(200).json({
        id,
        name: student.name,
        course: student.course,
        year_level: student.yearLevel,
    });
});

/**
 * DELETE /api/students/:id
 * Remove a student.
 * 204 — deleted
 * 400 — id is not a positive integer
 * 404 — no student with that id
 */
app.delete("/api/students/:id", async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) {
        throw new ApiError(400, "INVALID_ID", "id must be a positive integer");
    }

    const [result] = await pool.query("DELETE FROM students WHERE id = ?", [id]);

    if (result.affectedRows === 0) {
        throw new ApiError(404, "NOT_FOUND", `No student with id ${id}`);
    }

    res.status(204).end();
});

// Any other method on the student paths → 405, with an Allow header.
app.all("/api/students", methodNotAllowed(["GET", "POST"]));
app.all("/api/students/:id", methodNotAllowed(["GET", "PUT", "DELETE"]));

// Fallback for any route not matched above.
app.use((req, res) => {
    res.status(404).json({
        error: {
            code: "NOT_FOUND",
            message: `Cannot ${req.method} ${req.originalUrl}`,
        },
    });
});

/**
 * Turn anything a route throws into a status code plus an error envelope.
 * Order matters: parser errors first, then deliberate ApiErrors, then driver codes.
 */
function normalizeError(err) {
    if (err.type === "entity.too.large") {
        return { status: 413, code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" };
    }
    if (err.type === "entity.parse.failed" || (err instanceof SyntaxError && "body" in err)) {
        return { status: 400, code: "INVALID_JSON", message: "Request body is not valid JSON" };
    }
    if (err instanceof ApiError) {
        return { status: err.status, code: err.code, message: err.message, details: err.details };
    }

    const mapped = MYSQL_ERRORS[err?.code];
    if (mapped) {
        const [status, code, message] = mapped;
        return { status, code, message };
    }

    return { status: 500, code: "INTERNAL_ERROR", message: "Internal server error" };
}

// Must stay last so it catches everything above.
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);

    const { status, code, message, details } = normalizeError(err);

    if (status >= 500) {
        console.error(`[${req.method} ${req.originalUrl}] ${status} ${code}`, err);
    }

    res.status(status).json({
        error: {
            code,
            // Keep driver text out of production 5xx responses.
            message: status >= 500 && IS_PROD ? "Internal server error" : message,
            ...(details ? { details } : {}),
        },
    });
});

const server = app.listen(PORT, async () => {
    console.log(`Server running at http://localhost:${PORT}`);

    try {
        const [[row]] = await pool.query("SELECT DATABASE() AS db");
        console.log(`Connected to MySQL database \`${row.db}\``);
    } catch (err) {
        console.error(`MySQL connection failed: ${err.code || ""} ${err.message}`);
    }
});

function shutdown(signal) {
    console.log(`\n${signal} received — shutting down`);
    server.close(async () => {
        await pool.end().catch(() => {});
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
