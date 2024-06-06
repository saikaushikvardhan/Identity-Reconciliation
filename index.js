// To Do
// 1. Fix duplicate phone numbers and emails in the response.
// 2. Address the edge case of not finding a primary contact.
// 3. Address the edge case of adding to the missing fields instead of creating new contacts.
// 4. Fix proper demotion of the primary contacts to secondary contacts.

const http = require('http');
const { Sequelize, Op } = require('sequelize');
const { sequelize, Contact } = require('./models/contact');
const config = require('./config.json').development;

// Function to validate the request
function validateRequest(body) {
  if (!body) {
    throw new Error('Request body is required');
  }

  const { email, phoneNumber } = JSON.parse(body);

  if (!email && !phoneNumber) {
    throw new Error('Either email or phoneNumber must be provided');
  }

  return { email, phoneNumber };
}

sequelize.sync().then(() => {
  console.log('Database synchronized');

  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/identify') {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });

      req.on('end', async () => {
        try {
          // Validate the request
          const { email, phoneNumber } = validateRequest(body);

          let primaryContact;
          let secondaryContacts = new Set();

          // Fetch contacts with the given email
          const contactsWithSameEmail = await Contact.findAll({
            where: { email },
          });

          // Fetch contacts with the given phone number
          const contactsWithSamePhone = await Contact.findAll({
            where: { phoneNumber },
          });

          // If both arrays are empty, create a new primary contact
          if (contactsWithSameEmail.length === 0 && contactsWithSamePhone.length === 0) {
            primaryContact = await Contact.create({
              email,
              phoneNumber,
              linkPrecedence: 'primary',
            });

            const response = {
              contact: {
                primaryContactId: primaryContact.id,
                emails: [primaryContact.email].filter(Boolean),
                phoneNumbers: [primaryContact.phoneNumber].filter(Boolean),
                secondaryContactIds: [],
              }
            };

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
            return;
          }

          // Combine both arrays and find the primary contact
          const allContacts = [...contactsWithSameEmail, ...contactsWithSamePhone];
          const uniquePrimaryContacts = new Set();

          allContacts.forEach(contact => {
            if (contact.linkPrecedence === 'primary') {
              uniquePrimaryContacts.add(contact);
            } else {
              secondaryContacts.add(contact);
            }
          });

          // Handle the case of no primary contact being retrieved. 
          if (uniquePrimaryContacts.size > 1) {
            // If there are multiple primary contacts, demote the most recently updated one
            const sortedPrimaryContacts = Array.from(uniquePrimaryContacts).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
            primaryContact = sortedPrimaryContacts[0];

            for (let i = 1; i < sortedPrimaryContacts.length; i++) {
              await sortedPrimaryContacts[i].update({ linkPrecedence: 'secondary', linkedId: primaryContact.id });
              secondaryContacts.add(sortedPrimaryContacts[i]);
            }
          } else {
            primaryContact = uniquePrimaryContacts.values().next().value || allContacts[0];
          }

          // Fetch all contacts linked to the primary contact
          const linkedContacts = await Contact.findAll({
            where: {
              [Op.or]: [
                { linkedId: primaryContact.id },
                { id: primaryContact.id },
              ],
            }
          });

          // Update secondary contact if needed
          let newSecondaryContact;
          linkedContacts.forEach(contact => {
            if (contact.phoneNumber === phoneNumber && !contact.email && email) {
              contact.update({ email });
            }
            if (contact.linkPrecedence === 'secondary') {
              secondaryContacts.add(contact);
            }
          });

          if (!linkedContacts.some(contact => contact.email === email && contact.phoneNumber === phoneNumber)) {
            newSecondaryContact = await Contact.create({
              email,
              phoneNumber,
              linkedId: primaryContact.id,
              linkPrecedence: 'secondary',
            });
            secondaryContacts.add(newSecondaryContact);
          }

          const response = {
            contact: {
              primaryContactId: primaryContact.id,
              emails: [primaryContact.email, ...Array.from(secondaryContacts).map(contact => contact.email)].filter(Boolean),
              phoneNumbers: [primaryContact.phoneNumber, ...Array.from(secondaryContacts).map(contact => contact.phoneNumber)].filter(Boolean),
              secondaryContactIds: Array.from(secondaryContacts).map(contact => contact.id),
            }
          };

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      });
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    }
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });
}).catch(error => {
  console.error('Unable to sync the database:', error);
});
