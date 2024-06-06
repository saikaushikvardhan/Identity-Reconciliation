// Bug Report
// 1. Contact with latest timestamp is marked as primary.
// 2. Duplicate secondary contacts are being created.

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

async function demotePrimaryContactsToSecondary(sortedUniquePrimaryContacts) {
  const mainPrimaryContact = sortedUniquePrimaryContacts[0];

  for (let i = 1; i < sortedUniquePrimaryContacts.length; i++) {
    let currentPrimaryContact = sortedUniquePrimaryContacts[i];

    // Fetch linked contacts for the current primary contact
    let linkedContacts = await Contact.findAll({
      where: {
        [Op.or]: [
          { linkedId: currentPrimaryContact.id },
          { id: currentPrimaryContact.id },
        ],
      }
    });

    // Update linked contacts to point to the main primary contact
    for (let linkedContact of linkedContacts) {
      // Skip if the linked contact is the main primary contact
      if (linkedContact.id === mainPrimaryContact.id) continue;

      await linkedContact.update({ linkPrecedence: 'secondary', linkedId: mainPrimaryContact.id });
    }
  }
}


// function to find or create the primary contact.
async function findOrCreatePrimaryContact(email, phoneNumber) {
  let primaryContact = null;

  // Fetch contacts with the given email
  const contactsWithSameEmail = await Contact.findAll({
    where: { email },
  });

  // Fetch contacts with the given phone number
  const contactsWithSamePhone = await Contact.findAll({
    where: { phoneNumber },
  });

  if (contactsWithSameEmail.length === 0 && contactsWithSamePhone.length === 0) {
    primaryContact = await Contact.create({
      email,
      phoneNumber,
      linkPrecedence: 'primary',
    });

    return primaryContact;
  }

  // Combine both arrays and find the primary contact
  let allContacts = [...contactsWithSameEmail, ...contactsWithSamePhone];
  let uniquePrimaryContacts = new Set();

  // Find all the related primary contacts for the given contacts 
  for (const contact of allContacts) {
    if (contact.linkPrecedence === 'primary') {
      uniquePrimaryContacts.add(contact);
    } else if (contact.linkedId) {
      // If it's a secondary contact, fetch the linked primary contact
      const linkedPrimaryContact = await Contact.findByPk(contact.linkedId);
      if (linkedPrimaryContact && linkedPrimaryContact.linkPrecedence === 'primary') {
        uniquePrimaryContacts.add(linkedPrimaryContact);
      }
    }
  }

  if (uniquePrimaryContacts.size === 1) {
    primaryContact = Array.from(uniquePrimaryContacts)[0];
  } else if (uniquePrimaryContacts.size > 1) {
    // More than one primary contact in the given array.
    const sortedPrimaryContacts = Array.from(uniquePrimaryContacts).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    await demotePrimaryContactsToSecondary(sortedPrimaryContacts);
    primaryContact = sortedPrimaryContacts[0];
  }
  
  return primaryContact;
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
          let primaryContact = await findOrCreatePrimaryContact(email, phoneNumber);

          if (!primaryContact) {
            console.log("Found no primary key");
            throw "Invalid request";
          }

          let secondaryContacts = await Contact.findAll({
            where: {
              [Op.or]: [
                { linkedId: primaryContact.id }
              ]
            }
          });

          let phoneNumbers = new Set();
          let emails = new Set();

          if (primaryContact.phoneNumber) phoneNumbers.add(primaryContact.phoneNumber);
          if (primaryContact.email) emails.add(primaryContact.email);

          for (let contact of secondaryContacts) {
            if (contact.phoneNumber) phoneNumbers.add(contact.phoneNumber);
            if (contact.email) emails.add(contact.email);
          }

          if ((email && !emails.has(email)) || (phoneNumber && !phoneNumbers.has(phoneNumber))) {
            await Contact.create({
              email,
              phoneNumber,
              linkedId: primaryContact.id,
              linkPrecedence: 'secondary'
            })
            emails.add(email);
            phoneNumbers.add(phoneNumber);
          }

          const response = {
            contact: {
              primaryContactId: primaryContact.id,
              emails: Array.from(emails).filter(Boolean),
              phoneNumbers: Array.from(phoneNumbers).filter(Boolean),
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
      res.end(JSON.stringify({ error: 'Please hit the identify end point with appropriate params' }));
    }
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });
}).catch(error => {
  console.error('Unable to sync the database:', error);
});
