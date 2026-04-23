import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

class PopupErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error) {
    console.error("Popup crashed:", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: "16px", fontFamily: "Inter, sans-serif", color: "#fff" }}>
          <h2>WatchParty</h2>
          <p>Popup crashed. Please close and reopen the extension popup.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <PopupErrorBoundary>
      <App />
    </PopupErrorBoundary>
  </React.StrictMode>
);
