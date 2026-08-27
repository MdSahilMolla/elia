import sqlite3
from flask import Flask, g, render_template, request, redirect, url_for

app = Flask(__name__)

app.config['DATABASE'] = 'notes.db'

def get_db():
    db = getattr(g, '_database', None)
    if db is None:
        db = g._database = sqlite3.connect(app.config['DATABASE'])
        db.row_factory = sqlite3.Row
    return db

def init_db():
    with app.app_context():
        db = get_db()
        db.execute('''
            CREATE TABLE IF NOT EXISTS notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        db.commit()

@app.teardown_appcontext
def close_connection(exception):
    db = getattr(g, '_database', None)
    if db is not None:
        db.close()

@app.route('/', methods=['GET', 'POST'])
def index():
    db = get_db()
    if request.method == 'POST':
        content = request.form.get('content', '').strip()
        if content:
            db.execute('INSERT INTO notes (content) VALUES (?)', (content,))
            db.commit()
        return redirect(url_for('index'))
    cur = db.execute('SELECT id, content, created_at FROM notes ORDER BY created_at DESC')
    notes = cur.fetchall()
    return render_template('index.html', notes=notes)

if __name__ == '__main__':
    init_db()
    app.run(debug=True, port=3030)
