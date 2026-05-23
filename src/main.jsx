import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { ThruProvider } from '@thru/react-sdk'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThruProvider
      config={{
        iframeUrl: "https://wallet.thru.org/embedded",
        rpcUrl: "https://grpc-web.alphanet.thruput.org",
      }}
    >
      <App />
    </ThruProvider>
  </React.StrictMode>,
)