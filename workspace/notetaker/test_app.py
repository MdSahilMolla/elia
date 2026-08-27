import os
import sqlite3
from flask import Flask

# Ensure fresh DB for test
DB_PATH = os.path.join(os.path.dirname(__file__), 'test_notes.db')
if os.path.exists(DB_PATH):
    os.remove(DB_PATH)

# Import the app factory
from app import app, get_db, init_db

# Override the DATABASE constant if needed
app.config['TESTING'] = True

with app.app_context():
    # Use test DB
    app.config['DATABASE'] = DB_PATH
    # Reinitialize DB
    init_db()
    client = app.test_client()
    # GET home
    resp = client.get('/')
    assert resp.status_code == 200
    # POST a note
    resp = client.post('/', data={'content': 'Hello world'})
    assert resp.status_code == 302  # redirect
    # Follow redirect
    resp = client.get('/')
    assert b'Hello world' in resp.data
    print('All tests passed')
