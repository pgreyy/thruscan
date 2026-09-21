import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './popup.css'

if (new URLSearchParams(location.search).get('tab') === '1') document.documentElement.classList.add('tab')
createRoot(document.getElementById('root')).render(<App />)
