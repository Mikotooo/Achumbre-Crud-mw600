# Student Management System (MW600)

Student records CRUD mini system — Express + MySQL, single-file backend
(`server.js`) with a plain HTML frontend (`index.html`).

## Setup

```sh
npm install
cp .env.example .env    # fill in your MySQL credentials
npm run db:push         # creates the database and imports student_db.sql
npm start
```

Then open http://localhost:3000

## API

| Method   | Path                | Description   |
| -------- | ------------------- | ------------- |
| `GET`    | `/api/students`     | list students |
| `GET`    | `/api/students/:id` | one student   |
| `POST`   | `/api/students`     | create        |
| `PUT`    | `/api/students/:id` | update        |
| `DELETE` | `/api/students/:id` | delete        |

Ids are 8 digits: a 2-digit year plus a 6-digit counter that resets each year,
so the first student added in 2026 is `26000001`.
# Achumbre-Cud-mw600
