import { ConDash } from "socratic-trade-dashboard";

export const AsEmptyValue = () => (
  <div className="console-root" style={{ padding: 8 }}>
    <table className="con-table">
      <thead>
        <tr>
          <th>Symbol</th>
          <th>Last</th>
          <th>P/E</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>AAPL</td>
          <td>231.10</td>
          <td>29.4</td>
        </tr>
        <tr>
          <td>NVDA</td>
          <td>142.88</td>
          <td>n/a</td>
        </tr>
        <tr>
          <td>PLTR</td>
          <td>
            <ConDash />
          </td>
          <td>
            <ConDash />
          </td>
        </tr>
      </tbody>
    </table>
  </div>
);
