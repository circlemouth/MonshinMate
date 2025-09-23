import React from 'react';
import { renderToString } from 'react-dom/server';
import AdminTimezone from '../src/pages/AdminTimezone';
import { ThemeColorProvider } from '../src/contexts/ThemeColorContext';
import { TimezoneProvider } from '../src/contexts/TimezoneContext';

const html = renderToString(
  <ThemeColorProvider>
    <TimezoneProvider>
      <AdminTimezone />
    </TimezoneProvider>
  </ThemeColorProvider>
);

console.log(html);
